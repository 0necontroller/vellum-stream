import {
  createVideoRecord,
  getVideoRecord,
  getAllVideos,
  updateVideoRecord,
} from "../lib/videoStore";
import fs from "fs";
import path from "path";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { ENV } from "../lib/environments";
import { Request, Response } from "express";
import { BUCKET_NAME } from "../lib/s3client";
import { IServerResponse } from "../types/response";
import { processVideoAsync } from "./utils/upload-utils";
import { validateUpload, formatValidationErrors } from "../lib/validation";

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: API_KEY
 *       description: Bearer token authentication using API key from environment
 *   schemas:
 *     VideoUploadSessionRequest:
 *       type: object
 *       required:
 *         - filename
 *         - filesize
 *       properties:
 *         filename:
 *           type: string
 *           description: Name of the video file
 *           example: "video.mp4"
 *         filesize:
 *           type: number
 *           description: Size of the video file in bytes
 *           example: 104857600
 *         packager:
 *           type: string
 *           enum: [ffmpeg]
 *           default: ffmpeg
 *           description: Video processing packager to use
 *         callbackUrl:
 *           type: string
 *           description: Optional webhook URL for processing completion notifications
 *           example: "https://myapp.com/webhook"
 *         s3Path:
 *           type: string
 *           description: Optional custom S3 path for storing the video (e.g., "/v2/media")
 *           example: "/v2/media"
 *         uploadToS3:
 *           type: boolean
 *           default: false
 *           description: Whether to upload an MP4 version of the video to S3 alongside HLS segments
 *           example: true
 *         type:
 *           type: string
 *           enum: [direct, tus]
 *           default: tus
 *           description: Upload method - 'direct' for multipart form upload or 'tus' for resumable uploads
 *           example: "tus"
 *     VideoUploadSessionResponse:
 *       type: object
 *       properties:
 *         uploadId:
 *           type: string
 *           description: Unique identifier for the upload session
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         uploadUrl:
 *           type: string
 *           description: Upload URL - TUS endpoint for resumable uploads or direct endpoint for form uploads
 *           example: "http://localhost:8001/api/v1/tus/files/550e8400-e29b-41d4-a716-446655440000"
 *         videoUrl:
 *           type: string
 *           description: Future HLS streaming URL where the processed video will be available
 *           example: "http://localhost:9000/video-streams/550e8400-e29b-41d4-a716-446655440000/index.m3u8"
 *         expiresIn:
 *           type: number
 *           description: Upload session expiration time in seconds
 *           example: 3600
 *         mp4Url:
 *           type: string
 *           description: Future MP4 URL where the processed video will be available (only included if uploadToS3 is true)
 *           example: "http://localhost:9000/video-streams/550e8400-e29b-41d4-a716-446655440000/video.mp4"
 *     VideoStatus:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Video identifier
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         filename:
 *           type: string
 *           description: Original filename
 *           example: "video.mp4"
 *         status:
 *           type: string
 *           enum: [uploading, processing, completed, failed]
 *           description: Current processing status
 *         progress:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *           description: Processing progress percentage
 *           example: 75
 *         streamUrl:
 *           type: string
 *           description: HLS streaming URL (available when completed)
 *           example: "http://localhost:9000/video-streams/550e8400-e29b-41d4-a716-446655440000/playlist.m3u8"
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         completedAt:
 *           type: string
 *           format: date-time
 *           description: Completion timestamp (if completed)
 *         error:
 *           type: string
 *           description: Error message (if failed)
 *         s3Path:
 *           type: string
 *           description: Custom S3 path where the video is stored
 *           example: "/v2/media"
 *         uploadToS3:
 *           type: boolean
 *           description: Whether MP4 upload to S3 was requested
 *           example: true
 *         mp4Url:
 *           type: string
 *           description: S3 URL of the MP4 file (available when completed and uploadToS3 was true)
 *           example: "http://localhost:9000/video-streams/550e8400-e29b-41d4-a716-446655440000/video.mp4"
 *         uploadType:
 *           type: string
 *           enum: [direct, tus]
 *           description: Upload method used
 *           example: "tus"
 */

/**
 * @openapi
 * /api/v1/video/create:
 *   post:
 *     summary: Create a video upload session
 *     description: Creates an upload session and returns an upload URL. Supports both TUS resumable uploads (max 100MB) and direct multipart form uploads (max 200MB). Optionally converts and uploads MP4 version to S3.
 *     tags: [Video]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VideoUploadSessionRequest'
 *     responses:
 *       200:
 *         description: Upload session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: success
 *                     message:
 *                       example: Upload session created
 *                     data:
 *                       $ref: '#/components/schemas/VideoUploadSessionResponse'
 *       400:
 *         description: Invalid request parameters or validation errors
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: File size (150MB) exceeds maximum allowed size (100MB) for TUS uploads, or (200MB) for direct uploads
 *       422:
 *         description: Validation error for uploadToS3 parameter
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: uploadToS3 must be a boolean
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: Invalid API key
 */
export const createVideoUpload = async (
  req: Request,
  res: Response<IServerResponse>
) => {
  try {
    const {
      filename,
      filesize,
      packager = "ffmpeg",
      callbackUrl,
      s3Path,
      uploadToS3 = false,
      type = "tus",
    } = req.body;

    if (!filename || !filesize) {
      res.status(400).json({
        status: "error",
        message: "Missing required fields: filename and filesize",
        data: null,
      });
      return;
    }

    // Validate upload constraints (file size, type, and max files)
    // For direct uploads, allow up to 200MB, otherwise use default validation
    let validationResult;
    if (type === "direct") {
      const maxDirectUploadSize = 200 * 1024 * 1024; // 200MB in bytes
      if (filesize > maxDirectUploadSize) {
        const maxSizeMB = Math.round(maxDirectUploadSize / (1024 * 1024));
        const fileSizeMB = Math.round(filesize / (1024 * 1024));
        res.status(400).json({
          status: "error",
          message: `File size (${fileSizeMB}MB) exceeds maximum allowed size for direct uploads (${maxSizeMB}MB)`,
          data: null,
        });
        return;
      }
      validationResult = validateUpload(filename, filesize);
      // Override file size validation result if it passed our custom check
      if (!validationResult.isValid) {
        // Filter out file size errors since we handled it above
        const nonSizeErrors = validationResult.errors.filter(
          (error) => !error.message.includes("File size")
        );
        if (nonSizeErrors.length === 0) {
          validationResult = { isValid: true, errors: [] };
        } else {
          validationResult = { isValid: false, errors: nonSizeErrors };
        }
      }
    } else {
      validationResult = validateUpload(filename, filesize);
    }
    if (!validationResult.isValid) {
      res.status(400).json({
        status: "error",
        message: formatValidationErrors(validationResult.errors),
        data: null,
      });
      return;
    }

    if (s3Path && typeof s3Path !== "string") {
      res.status(400).json({
        status: "error",
        message: "s3Path must be a string",
        data: null,
      });
      return;
    }

    if (uploadToS3 !== undefined && typeof uploadToS3 !== "boolean") {
      res.status(400).json({
        status: "error",
        message: "uploadToS3 must be a boolean",
        data: null,
      });
      return;
    }

    if (type && !["direct", "tus"].includes(type)) {
      res.status(400).json({
        status: "error",
        message: "type must be either 'direct' or 'tus'",
        data: null,
      });
      return;
    }

    // remove leading/trailing slashes and ensure it's a valid s3 path
    let cleanS3Path = s3Path;
    if (cleanS3Path) {
      cleanS3Path = cleanS3Path.trim();
      if (cleanS3Path && !cleanS3Path.match(/^[a-zA-Z0-9/_-]+$/)) {
        res.status(400).json({
          status: "error",
          message:
            "s3Path contains invalid characters. Only alphanumeric, forward slashes, hyphens, and underscores are allowed",
          data: null,
        });
        return;
      }
    }

    const uploadId = uuidv4();
    const uploadUrl =
      type === "direct"
        ? `${ENV.VELLUM_HOST}/api/v1/video/${uploadId}/upload`
        : `${ENV.VELLUM_HOST}/api/v1/tus/files/${uploadId}`;

    createVideoRecord({
      id: uploadId,
      filename,
      status: "uploading",
      packager,
      callbackUrl,
      s3Path: cleanS3Path,
      uploadToS3,
      uploadType: type,
    });

    const s3Prefix = cleanS3Path
      ? `${cleanS3Path.replace(/^\/|\/$/g, "")}/${uploadId}`
      : uploadId;
    const videoUrl = `${BUCKET_NAME}.${ENV.S3_ENDPOINT}/${s3Prefix}/index.m3u8`;

    const mp4Url = uploadToS3
      ? `${BUCKET_NAME}.${ENV.S3_ENDPOINT}/${s3Prefix}/video.mp4`
      : undefined;

    const responseData: any = {
      uploadId,
      uploadUrl,
      videoUrl,
      expiresIn: 3600,
    };

    if (uploadToS3) {
      responseData.mp4Url = mp4Url;
    }

    res.json({
      status: "success",
      message: "Upload session created",
      data: responseData,
    });
  } catch (error) {
    console.error("Error creating video upload session:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to create upload session",
      data: null,
    });
  }
};

/**
 * @openapi
 * /api/v1/video/{uploadId}/status:
 *   get:
 *     summary: Get video processing status
 *     tags: [Video]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: The video upload ID
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Video status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: success
 *                     data:
 *                       $ref: '#/components/schemas/VideoStatus'
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: Invalid API key
 *       404:
 *         description: Video not found
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: Video not found
 */
export const getVideoStatus = async (
  req: Request,
  res: Response<IServerResponse>
) => {
  try {
    const { uploadId } = req.params;
    const video = getVideoRecord(uploadId);

    if (!video) {
      res.status(404).json({
        status: "error",
        message: "Video not found",
        data: null,
      });
      return;
    }

    res.json({
      status: "success",
      message: "Video status retrieved successfully",
      data: video,
    });
  } catch (error) {
    console.error("Error getting video status:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to get video status",
      data: null,
    });
  }
};

/**
 * @openapi
 * /api/v1/videos:
 *   get:
 *     summary: List all videos
 *     description: Get a list of all uploaded and processed videos
 *     tags: [Video]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Videos retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: success
 *                     message:
 *                       example: Videos retrieved successfully
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/VideoStatus'
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: Invalid API key
 */
export const listAllVideos = async (
  req: Request,
  res: Response<IServerResponse>
) => {
  try {
    const videos = getAllVideos();
    res.json({
      status: "success",
      message: "Videos retrieved successfully",
      data: videos,
    });
  } catch (error) {
    console.error("Error listing videos:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to list videos",
      data: null,
    });
  }
};

/**
 * @openapi
 * /api/v1/video/{uploadId}/callback-status:
 *   get:
 *     summary: Get callback status for a video
 *     description: Get the current callback delivery status for a specific video
 *     tags: [Video]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: Upload session ID
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Callback status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: success
 *                     message:
 *                       example: Callback status retrieved successfully
 *                     data:
 *                       type: object
 *                       properties:
 *                         callbackUrl:
 *                           type: string
 *                           nullable: true
 *                         callbackStatus:
 *                           type: string
 *                           enum: [pending, completed, failed]
 *                         callbackRetryCount:
 *                           type: number
 *                         callbackLastAttempt:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: Invalid API key
 *       404:
 *         description: Video not found
 */
export const getCallbackStatus = async (
  req: Request,
  res: Response<IServerResponse>
) => {
  try {
    const { uploadId } = req.params;
    const video = getVideoRecord(uploadId);

    if (!video) {
      res.status(404).json({
        status: "error",
        message: "Video not found",
        data: null,
      });
      return;
    }

    res.json({
      status: "success",
      message: "Callback status retrieved successfully",
      data: {
        callbackUrl: video.callbackUrl,
        callbackStatus: video.callbackStatus,
        callbackRetryCount: video.callbackRetryCount,
        callbackLastAttempt: video.callbackLastAttempt,
      },
    });
  } catch (error) {
    console.error("Error getting callback status:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to get callback status",
      data: null,
    });
  }
};

// Configure multer for file uploads
export const uploadDirect = multer({
  dest: path.join(process.cwd(), ENV.UPLOAD_PATH),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept video files
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

/**
 * @openapi
 * /api/v1/video/{uploadId}/upload:
 *   post:
 *     summary: Direct file upload for a video session
 *     description: Upload a video file directly using multipart/form-data for a pre-created upload session
 *     tags: [Video]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: uploadId
 *         required: true
 *         schema:
 *           type: string
 *         description: The video upload ID from the create session endpoint
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: The video file to upload
 *     responses:
 *       200:
 *         description: File uploaded successfully and processing started
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: success
 *                     message:
 *                       example: File uploaded successfully, processing started
 *                     data:
 *                       type: object
 *                       properties:
 *                         uploadId:
 *                           type: string
 *                           example: "550e8400-e29b-41d4-a716-446655440000"
 *                         filename:
 *                           type: string
 *                           example: "video.mp4"
 *                         status:
 *                           type: string
 *                           example: "processing"
 *       400:
 *         description: Invalid request or file validation failed
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ServerResponse'
 *                 - type: object
 *                   properties:
 *                     status:
 *                       example: error
 *                     message:
 *                       example: "No file uploaded or file validation failed"
 *       401:
 *         description: Unauthorized - Invalid or missing Bearer token
 *       404:
 *         description: Upload session not found or invalid
 *       409:
 *         description: Upload session is not in uploading state
 */
export const directUpload = async (
  req: Request,
  res: Response<IServerResponse>
) => {
  try {
    const { uploadId } = req.params;
    const file = req.file;

    // Check if file was uploaded
    if (!file) {
      res.status(400).json({
        status: "error",
        message: "No file uploaded",
        data: null,
      });
      return;
    }

    // Get the video record
    const videoRecord = getVideoRecord(uploadId);
    if (!videoRecord) {
      // Clean up uploaded file if record doesn't exist
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }

      res.status(404).json({
        status: "error",
        message: "Upload session not found",
        data: null,
      });
      return;
    }

    // Validate that the record is in the correct state
    if (videoRecord.status !== "uploading") {
      // Clean up uploaded file if record is in wrong state
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }

      res.status(409).json({
        status: "error",
        message: `Upload session is not in uploading state. Current status: ${videoRecord.status}`,
        data: null,
      });
      return;
    }

    // Validate uploaded file against original constraints
    const validationResult = validateUpload(
      file.originalname || videoRecord.filename,
      file.size
    );
    if (!validationResult.isValid) {
      // Clean up uploaded file if validation fails
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }

      res.status(400).json({
        status: "error",
        message: formatValidationErrors(validationResult.errors),
        data: null,
      });
      return;
    }

    // Rename the file to match the expected uploadId naming scheme
    const finalPath = path.join(path.dirname(file.path), uploadId);
    try {
      fs.renameSync(file.path, finalPath);
    } catch (renameError) {
      console.error(`Failed to rename uploaded file: ${renameError}`);

      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }

      res.status(500).json({
        status: "error",
        message: "Failed to process uploaded file",
        data: null,
      });
      return;
    }

    const updatedRecord = updateVideoRecord(uploadId, {
      progress: 0, // Reset progress for processing stage
      filename: file.originalname || videoRecord.filename, // Update with actual filename
    });

    if (!updatedRecord) {
      try {
        fs.unlinkSync(finalPath);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }

      res.status(500).json({
        status: "error",
        message: "Failed to update upload session",
        data: null,
      });
      return;
    }

    // Queue the video for processing
    await processVideoAsync({
      uploadId: uploadId,
      filePath: finalPath,
      filename: file.originalname || videoRecord.filename,
      packager: "ffmpeg",
      callbackUrl: videoRecord.callbackUrl,
      s3Path: videoRecord.s3Path,
      uploadToS3: videoRecord.uploadToS3,
    });

    res.json({
      status: "success",
      message: "File uploaded successfully, processing started",
      data: {
        uploadId,
        filename: file.originalname || videoRecord.filename,
        status: "processing",
      },
    });
  } catch (error) {
    console.error("Error in direct upload:", error);

    // Clean up uploaded file if it exists
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.warn(`Failed to cleanup uploaded file: ${cleanupError}`);
      }
    }

    res.status(500).json({
      status: "error",
      message: "Failed to process file upload",
      data: null,
    });
  }
};
