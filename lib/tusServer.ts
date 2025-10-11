import path from "path";
import { Server } from "@tus/server";
import { ENV } from "./environments";
import { FileStore } from "@tus/file-store";
import { publishToQueue, RabbitMQQueues } from "./rabbitmq";
import { updateVideoRecord, getVideoRecord } from "./videoStore";
import { validateUpload, formatValidationErrors } from "./validation";

export const createTusServer = () => {
  const server = new Server({
    path: "/api/v1/tus",
    respectForwardedHeaders: true,
    //maxSize: 500 * 1024 * 1024, // 500MB max upload size
    datastore: new FileStore({
      directory: path.join(process.cwd(), ENV.UPLOAD_PATH),
    }),
    onUploadFinish: async (req, upload) => {
      console.log(`Upload finished for ${upload.id}`);

      // Get the uploadId from metadata if provided, otherwise use TUS-generated ID
      const uploadId = upload.metadata?.uploadId || upload.id;

      // Double-check the record still exists
      const videoRecord = getVideoRecord(uploadId!);
      if (!videoRecord) {
        console.error(`Video record disappeared during upload: ${uploadId}`);
        return {};
      }

      // Update video record to indicate upload is complete (ready for processing)
      const updatedRecord = updateVideoRecord(uploadId!, {
        progress: 0, // Reset progress for processing stage
      });

      if (!updatedRecord) {
        console.error(`Failed to update video record: ${uploadId}`);
        return {};
      }

      // Trigger video processing via RabbitMQ
      await publishToQueue(RabbitMQQueues.VIDEO_PROCESSING, {
        uploadId: uploadId,
        filePath: upload.storage?.path,
        filename: upload.metadata?.filename || videoRecord.filename,
        packager: "ffmpeg",
        callbackUrl: videoRecord.callbackUrl,
        s3Path: videoRecord.s3Path,
        uploadToS3: videoRecord.uploadToS3,
      });

      console.log(`VIDEO QUEUED for processing: ${uploadId}`);
      return {};
    },
    onUploadCreate: async (req, upload) => {
      console.log(`Upload creation requested for ${upload.id}`);

      // Get the uploadId from metadata if provided, otherwise use TUS-generated ID
      const uploadId = upload.metadata?.uploadId || upload.id;

      // Check if video record exists
      const videoRecord = getVideoRecord(uploadId!);
      if (!videoRecord) {
        console.error(`No video record found for upload ID: ${uploadId}`);
        throw new Error(
          `Video record not found. Please create video record first using POST /api/v1/video/create`
        );
      }

      // Validate that the record is in the correct state
      if (videoRecord.status !== "uploading") {
        console.error(
          `Invalid video record status: ${videoRecord.status} for upload ID: ${uploadId}`
        );
        throw new Error(
          `Video record is not in uploading state. Current status: ${videoRecord.status}`
        );
      }

      // Additional validation of file constraints during TUS upload
      // This acts as a secondary check in case someone tries to bypass the API validation
      if (upload.size && upload.metadata?.filename) {
        const validationResult = validateUpload(
          upload.metadata.filename,
          upload.size
        );
        if (!validationResult.isValid) {
          console.error(
            ` TUS upload VALIDATION FAILED: ${formatValidationErrors(
              validationResult.errors
            )}`
          );
          throw new Error(
            `Upload validation failed: ${formatValidationErrors(
              validationResult.errors
            )}`
          );
        }
      }

      console.log(`Upload validated for ${uploadId}`);
      return {};
    },
  });

  return server;
};
