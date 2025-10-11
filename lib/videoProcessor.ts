import {
  updateVideoRecord,
  safelyTransitionToProcessing,
} from "../lib/videoStore";
import path from "path";
import axios from "axios";
import fs from "fs/promises";
import { Channel } from "amqplib";
import { ENV } from "../lib/environments";
import { RabbitMQQueues } from "../lib/rabbitmq";
import { transcodeAndUpload } from "../controllers/utils/upload-utils";

export interface VideoProcessingMessage {
  uploadId: string;
  filePath: string;
  filename: string;
  packager: "ffmpeg";
  callbackUrl?: string;
  s3Path?: string;
  uploadToS3?: boolean;
}

export const startVideoProcessingWorker = async (channel: Channel) => {
  try {
    console.log("Starting video processing worker...");

    await channel.assertQueue(RabbitMQQueues.VIDEO_PROCESSING, {
      durable: true,
    });

    // Set prefetch to 1 to process one video at a time
    channel.prefetch(1);

    // Add channel error handlers to prevent crashes
    channel.on("error", (err) => {
      console.error("Video processing CHANNEL ERROR:", err.message);
    });

    channel.on("close", () => {
      console.warn("Video processing channel closed");
    });

    channel.consume(RabbitMQQueues.VIDEO_PROCESSING, async (msg) => {
      if (!msg) return;

      let job: VideoProcessingMessage | null = null;
      let heartbeatInterval: NodeJS.Timeout | null = null;
      let messageAcknowledged = false;

      try {
        job = JSON.parse(msg.content.toString());

        if (!job) {
          console.error("Failed to parse job message");
          channel.ack(msg);
          messageAcknowledged = true;
          return;
        }

        console.log(`Processing video: ${job.filename} (${job.uploadId})`);

        // Safely transition to processing status with atomic database operation
        const transitionResult = safelyTransitionToProcessing(job.uploadId);

        if (!transitionResult.success) {
          if (transitionResult.record?.status === "processing") {
            console.log(
              `Video ${job.uploadId} is already being processed (progress: ${transitionResult.record.progress}%), skipping...`
            );
          } else if (transitionResult.record?.status === "completed") {
            console.log(
              `Video ${job.uploadId} is already completed, skipping...`
            );
          } else {
            console.log(
              `Video ${job.uploadId} cannot be transitioned to processing (current status: ${transitionResult.record?.status}, progress: ${transitionResult.record?.progress}%), skipping...`
            );
          }
          channel.ack(msg);
          messageAcknowledged = true;
          return;
        }

        console.log(
          `Successfully transitioned video ${job.uploadId} to processing status`
        );

        // Acknowledge the message early to prevent reprocessing if connection drops
        channel.ack(msg);
        messageAcknowledged = true;
        console.log(
          `Message acknowledged early for ${job.uploadId} to prevent duplicate processing`
        );

        // Start heartbeat to keep RabbitMQ connection alive during long processing
        heartbeatInterval = setInterval(() => {
          try {
            // Send a heartbeat by updating progress slightly to keep connection alive
            if (job) {
              console.log(`Processing heartbeat for ${job.uploadId}`);
            }
          } catch (error) {
            console.warn("Heartbeat check failed:", error);
          }
        }, 30000); // Send heartbeat every 30 seconds

        // Process the video
        const streamUrl = await transcodeAndUpload(
          job.filePath,
          job.filename,
          job.uploadId,
          job.s3Path,
          job.uploadToS3
        );

        // Clear heartbeat interval
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        // Generate thumbnail URL
        const s3Prefix = job.s3Path
          ? `${job.s3Path.replace(/^\/|\/$/g, "")}/${job.uploadId}`
          : job.uploadId;
        const thumbnailUrl = `${ENV.S3_BUCKET}.${ENV.S3_ENDPOINT}/${s3Prefix}/thumbnail.jpg`;

        // Update status to completed
        const updatedRecord = updateVideoRecord(job.uploadId, {
          status: "completed",
          progress: 100,
          streamUrl,
          thumbnailUrl,
        });

        console.log(`Video processing completed: ${job.filename}`);

        // Clean up all related files after successful processing and S3 upload
        await cleanupVideoFiles(job.uploadId, job.filePath);

        // Send webhook callback if provided
        if (job.callbackUrl && updatedRecord) {
          try {
            const callbackPayload: any = {
              videoId: job.uploadId,
              filename: job.filename,
              status: "completed",
              streamUrl,
              thumbnailUrl,
            };

            // Include MP4 URL in callback if available
            if (updatedRecord.mp4Url) {
              callbackPayload.mp4Url = updatedRecord.mp4Url;
            }

            const response = await axios.post(job.callbackUrl, callbackPayload);

            if (response.status === 200) {
              // Update callback status to completed
              updateVideoRecord(job.uploadId, {
                callbackStatus: "completed",
                callbackLastAttempt: new Date(),
              });
              console.log(
                `WEBHOOK CALLBACK sent successfully to: ${job.callbackUrl}`
              );
            } else {
              // First retry attempt failed, will be retried by cron job
              updateVideoRecord(job.uploadId, {
                callbackRetryCount: 1,
                callbackLastAttempt: new Date(),
              });
              console.log(
                `Webhook callback failed with status ${response.status}, will retry`
              );
            }
          } catch (webhookError: any) {
            // First retry attempt failed, will be retried by cron job
            updateVideoRecord(job.uploadId, {
              callbackRetryCount: 1,
              callbackLastAttempt: new Date(),
            });
            console.error(
              "Failed to send webhook callback, will retry:",
              webhookError.message
            );
          }
        }

        // Message was already acknowledged early, so no need to ack here
      } catch (error: any) {
        console.error("Video processing failed:", error.message);

        // Clear heartbeat interval on error
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        // If we haven't acknowledged the message yet, ack it now to prevent redelivery
        if (!messageAcknowledged && msg) {
          try {
            channel.ack(msg);
            messageAcknowledged = true;
            console.log(
              ` Message acknowledged on error for ${
                job?.uploadId || "unknown"
              }`
            );
          } catch (ackError) {
            console.warn(
              "FAILED to acknowledge message on error:",
              ackError
            );
          }
        }

        try {
          // If job was not parsed, try to parse it again for error handling
          if (!job) {
            job = JSON.parse(msg.content.toString());
          }

          if (job) {
            // Update status to failed
            const updatedRecord = updateVideoRecord(job.uploadId, {
              status: "failed",
              error:
                error instanceof Error ? error.message : "Processing failed",
            });

            // Clean up all related files even on failure to prevent disk space accumulation
            await cleanupVideoFiles(job.uploadId, job.filePath);

            // Send webhook callback for failure if provided
            if (job.callbackUrl && updatedRecord) {
              try {
                const response = await axios.post(job.callbackUrl, {
                  videoId: job.uploadId,
                  filename: job.filename,
                  status: "failed",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Processing failed",
                });

                if (response.status === 200) {
                  // Update callback status to completed
                  updateVideoRecord(job.uploadId, {
                    callbackStatus: "completed",
                    callbackLastAttempt: new Date(),
                  });
                } else {
                  // First retry attempt failed, will be retried by cron job
                  updateVideoRecord(job.uploadId, {
                    callbackRetryCount: 1,
                    callbackLastAttempt: new Date(),
                  });
                }
              } catch (webhookError: any) {
                // First retry attempt failed, will be retried by cron job
                updateVideoRecord(job.uploadId, {
                  callbackRetryCount: 1,
                  callbackLastAttempt: new Date(),
                });
                console.error(
                  "Failed to send failure webhook callback, will retry:",
                  webhookError.message
                );
              }
            }
          } else {
            console.error("Could not parse job for error handling");
          }
        } catch (parseError: any) {
          console.error(
            "Failed to parse message for error handling:",
            parseError.message
          );
        }

        // Message was already acknowledged early, so no need to ack here again
      }
    });

  } catch (error: any) {
    console.error("Failed to start video processing worker:", error.message);
    throw error;
  }
};
/**
 * Clean up all files related to a video processing job
 */
const cleanupVideoFiles = async (
  uploadId: string,
  originalFilePath: string
) => {
  console.log(`Starting CLEANUP for uploadId: ${uploadId}`);
  const cleanupTasks = [];

  // 1. Clean up the original video file from TUS uploads directory
  console.log(`Attempting to CLEANUP original file: ${originalFilePath}`);
  cleanupTasks.push(
    fs
      .unlink(originalFilePath)
      .then(() =>
        console.log(`Cleaned up original video file: ${originalFilePath}`)
      )
      .catch((error) =>
        console.warn(
          `Failed to cleanup original video file ${originalFilePath}:`,
          error.message
        )
      )
  );

  // 2. Clean up TUS-related files (metadata files, etc.)
  // Use absolute path from process.cwd() instead of __dirname to avoid build path issues
  const uploadsDir = path.resolve(process.cwd(), ENV.UPLOAD_PATH);
  console.log(`TUS uploads directory: ${uploadsDir}`);
  const tusFiles = [
    path.join(uploadsDir, `${uploadId}.json`), // TUS metadata file
    path.join(uploadsDir, uploadId), // TUS data file (if exists)
  ];

  for (const tusFile of tusFiles) {
    console.log(`Attempting to cleanup TUS file: ${tusFile}`);
    cleanupTasks.push(
      fs
        .unlink(tusFile)
        .then(() => console.log(`Cleaned up TUS file: ${tusFile}`))
        .catch((error) => {
          // Only log as warning since some files might not exist
          if (error.code !== "ENOENT") {
            console.warn(
              `Failed to cleanup TUS file ${tusFile}:`,
              error.message
            );
          } else {
            console.log(`TUS file not found (already cleaned): ${tusFile}`);
          }
        })
    );
  }

  // 3. Clean up processed video files directory (HLS segments, playlist, etc.)
  // The video processing creates files in controllers/videos/ directory
  const processedVideoDir = path.resolve(
    process.cwd(),
    "controllers",
    "videos",
    uploadId
  );
  console.log(
    `Attempting to cleanup processed video directory: ${processedVideoDir}`
  );
  cleanupTasks.push(
    fs
      .rm(processedVideoDir, { recursive: true, force: true })
      .then(() =>
        console.log(
          `Cleaned up processed video directory: ${processedVideoDir}`
        )
      )
      .catch((error) =>
        console.warn(
          `Failed to cleanup processed video directory ${processedVideoDir}:`,
          error.message
        )
      )
  );

  // Execute all cleanup tasks in parallel
  await Promise.allSettled(cleanupTasks);
  console.log(`Cleanup completed for uploadId: ${uploadId}`);
};
