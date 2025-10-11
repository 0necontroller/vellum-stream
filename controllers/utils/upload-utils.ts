import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { ENV } from "../../lib/environments";
import { s3Client, BUCKET_NAME } from "../../lib/s3client";
import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { publishToQueue, RabbitMQQueues } from "../../lib/rabbitmq";
import { updateVideoRecord, getVideoRecord } from "../../lib/videoStore";

export interface VideoProcessingJob {
  uploadId: string;
  filePath: string;
  filename: string;
  packager: "ffmpeg";
  callbackUrl?: string;
  s3Path?: string;
  uploadToS3?: boolean;
}

export const processVideoAsync = async (job: VideoProcessingJob) => {
  await publishToQueue(RabbitMQQueues.VIDEO_PROCESSING, job);
};

// Function to upload files recursively (for handling subdirectories)
async function uploadFile(dirPath: string, prefix: string, uploadId?: string) {
  const files = await fsPromises.readdir(dirPath);

  // Process files in batches to reduce memory pressure
  const BATCH_SIZE = 5;
  const fileBatches = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    fileBatches.push(files.slice(i, i + BATCH_SIZE));
  }

  let uploadedCount = 0;
  let totalFiles = 0;

  // Count total files for progress tracking
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = await fsPromises.stat(filePath);
    if (!stats.isDirectory()) {
      totalFiles++;
    }
  }

  for (const batch of fileBatches) {
    const uploadPromises = batch.map(async (file) => {
      const filePath = path.join(dirPath, file);
      const stats = await fsPromises.stat(filePath);

      if (stats.isDirectory()) {
        // Create a new prefix for the subdirectory and recurse
        const newPrefix = `${prefix}/${file}`;
        await uploadFile(filePath, newPrefix, uploadId);
      } else {
        // Upload the file using streaming to reduce memory usage
        const data = await fsPromises.readFile(filePath);

        // Determine content type based on file extension
        let contentType;
        if (file.endsWith(".m3u8")) {
          contentType = "application/vnd.apple.mpegurl";
        } else if (file.endsWith(".ts")) {
          contentType = "video/MP2T";
        } else if (file.endsWith(".mp4")) {
          contentType = "video/mp4";
        } else if (file.endsWith(".m4s")) {
          contentType = "video/iso.segment";
        } else if (file.endsWith(".mpd")) {
          contentType = "application/dash+xml";
        } else if (file.endsWith(".vtt")) {
          contentType = "text/vtt";
        } else if (file.endsWith(".jpg") || file.endsWith(".jpeg")) {
          contentType = "image/jpeg";
        } else if (file.endsWith(".png")) {
          contentType = "image/png";
        } else {
          contentType = "application/octet-stream";
        }

        const key = `${prefix}/${file}`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: data,
            ContentType: contentType,
            ACL: "public-read",
          })
        );
        console.log(`Uploaded: ${key}`);
        uploadedCount++;

        // Update progress periodically during upload
        if (uploadId && totalFiles > 10 && uploadedCount % 5 === 0) {
          const uploadProgress =
            Math.floor((uploadedCount / totalFiles) * 15) + 80; // 80-95% range
          updateVideoRecord(uploadId, {
            progress: Math.min(uploadProgress, 95),
          });
        }
      }
    });

    // Process batch uploads in parallel
    await Promise.all(uploadPromises);

    // Add a small delay between batches to prevent overwhelming the system
    if (fileBatches.indexOf(batch) < fileBatches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const listFiles = (dir: string, indent = "") => {
  if (!fs.existsSync(dir)) {
    console.log(`${indent}Directory not found: ${dir}`);
    return;
  }

  const items = fs.readdirSync(dir);
  items.forEach((item) => {
    const itemPath = path.join(dir, item);
    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      console.log(`${indent} ${item}/`);
      listFiles(itemPath, indent + "  ");
    } else {
      const size = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`${indent} ${item} (${size} MB)`);
    }
  });
};

export async function transcodeAndUpload(
  localPath: string,
  filename: string,
  uploadId?: string,
  s3Path?: string,
  uploadToS3?: boolean
) {
  const name = uploadId || path.parse(filename).name;

  // Double-check if this video is already completed to prevent re-processing
  if (uploadId) {
    const currentRecord = getVideoRecord(uploadId);
    if (currentRecord && currentRecord.status === "completed") {
      console.log(
        `Video ${uploadId} is already completed, skipping transcoding...`
      );
      return currentRecord.streamUrl || "";
    }
    if (currentRecord && currentRecord.status === "failed") {
      console.log(`Video ${uploadId} previously failed, retrying...`);
      // Reset status to processing for retry
      updateVideoRecord(uploadId, {
        status: "processing",
        progress: 25,
        error: undefined,
      });
    }
  }

  // Construct the S3 prefix using custom path if provided
  const s3Prefix = s3Path ? `${s3Path.replace(/^\/|\/$/g, "")}/${name}` : name;

  // Use absolute path from process.cwd() to avoid build path issues
  const outputDir = path.resolve(process.cwd(), "controllers", "videos", name);
  fs.mkdirSync(outputDir, { recursive: true });

  // Declare codecInfo variable for use throughout the function
  let codecInfo: VideoCodecInfo;

  // Update progress if uploadId is provided
  if (uploadId) {
    updateVideoRecord(uploadId, { progress: 25 });
  }

  try {
    codecInfo = await probeVideoCodecs(localPath);
    console.log(`Codec Analysis:
      - Video: ${codecInfo.videoCodec} ${
      codecInfo.videoProfile ? `(${codecInfo.videoProfile})` : ""
    }
      - Audio: ${codecInfo.audioCodec}
      - Container: ${codecInfo.containerFormat}
      - HLS Compatible: ${codecInfo.isHlsCompatible ? "COMPATIBLE" : "IN-COMPATIBLE"}
      - Strategy: ${codecInfo.recommendedStrategy.toUpperCase()}`);
  } catch (error) {
    console.warn(
      "Failed to probe codecs, falling back to re-encode:",
      error
    );
    codecInfo = {
      videoCodec: "unknown",
      audioCodec: "unknown",
      containerFormat: "unknown",
      isHlsCompatible: false,
      recommendedStrategy: "reencode",
    };
  }

  // Build optimized FFmpeg command based on codec analysis
  const outputPath = path.join(outputDir, "index.m3u8");
  const cmd = buildOptimizedFFmpegCommand(
    codecInfo.recommendedStrategy,
    localPath,
    outputPath
  );

  // Estimate processing time for logging
  let fileSize = 0;
  try {
    const stats = await fsPromises.stat(localPath);
    fileSize = stats.size;
  } catch (error) {
    console.warn("Could not get file size for time estimation");
  }

  const estimatedTime = estimateProcessingTime(
    codecInfo.recommendedStrategy,
    fileSize
  );

  console.log(
    `Starting ${codecInfo.recommendedStrategy.toUpperCase()} transcoding (estimated: ${Math.round(
      estimatedTime
    )}s)...`
  );

  try {
    console.log(`Input file: ${localPath}`);
    console.log(`Output directory: ${outputDir}`);
    console.log(`Executing command: ${cmd}`);

    const startTime = Date.now();
    execSync(cmd, { stdio: "inherit" });
    const actualTime = (Date.now() - startTime) / 1000;

    const speedupFactor =
      codecInfo.recommendedStrategy === "reencode"
        ? 1
        : Math.round((estimatedTime * 2) / actualTime);
    console.log(
      `${codecInfo.recommendedStrategy.toUpperCase()} transcoding completed in ${Math.round(
        actualTime
      )}s ${
        speedupFactor > 1 ? `(~${speedupFactor}x faster than re-encoding)` : ""
      }`
    );

    // Update progress if uploadId is provided
    if (uploadId) {
      updateVideoRecord(uploadId, { progress: 60 });
    }

    const thumbnailPath = path.join(outputDir, "thumbnail.jpg");
    const thumbnailCmd = `ffmpeg -y -i "${localPath}" -ss 00:00:01.000 -vframes 1 -q:v 2 "${thumbnailPath}"`;

    execSync(thumbnailCmd, { stdio: "inherit" });

    if (fs.existsSync(thumbnailPath)) {
      console.log(`Thumbnail generated successfully: ${thumbnailPath}`);
    } else {
      console.warn("Thumbnail generation may have failed - file not found");
    }

    // Update progress if uploadId is provided
    if (uploadId) {
      updateVideoRecord(uploadId, { progress: 75 });
    }

    // Verify essential files exist
    const masterPlaylist = path.join(outputDir, "index.m3u8");
    if (!fs.existsSync(masterPlaylist)) {
      throw new Error(`Master playlist file not found at ${masterPlaylist}`);
    }

    listFiles(outputDir);
  } catch (error) {
    console.error(
      `Error during ${
        codecInfo?.recommendedStrategy || "unknown"
      } transcoding:`,
      error
    );

    // If stream copy failed, try fallback to re-encoding
    if (
      codecInfo?.recommendedStrategy === "copy" ||
      codecInfo?.recommendedStrategy === "selective"
    ) {
      console.log(
        "Stream copy failed, attempting fallback to re-encoding..."
      );
      try {
        const fallbackCmd = buildOptimizedFFmpegCommand(
          "reencode",
          localPath,
          outputPath
        );
        console.log(`Executing fallback command: ${fallbackCmd}`);
        execSync(fallbackCmd, { stdio: "inherit" });
        console.log("Fallback re-encoding completed successfully");
      } catch (fallbackError) {
        console.error("Fallback re-encoding also failed:", fallbackError);
        throw new Error(
          "Failed to transcode video with both stream copy and re-encoding"
        );
      }
    } else {
      throw new Error(
        `Failed to transcode video with ${
          codecInfo?.recommendedStrategy || "FFmpeg"
        }`
      );
    }
  }

  // Handle MP4 conversion and upload if uploadToS3 flag is enabled
  let mp4Url: string | undefined;
  if (uploadToS3) {
    try {
      console.log("Processing MP4 upload as requested...");

      let mp4FilePath: string;

      if (codecInfo && codecInfo.containerFormat.includes("mp4")) {
        console.log(
          "Source video is already in MP4 container format, using original file"
        );
        mp4FilePath = localPath;
      } else {
        console.log(
          `Source container: ${
            codecInfo?.containerFormat || "unknown"
          }, converting to MP4...`
        );
        mp4FilePath = path.join(outputDir, "video.mp4");
        await convertToMp4(localPath, mp4FilePath, uploadId);
      }

      const mp4S3Key = `${s3Prefix}/video.mp4`;
      mp4Url = await uploadMp4ToS3(mp4FilePath, mp4S3Key, uploadId);

      if (uploadId) {
        updateVideoRecord(uploadId, { mp4Url });
      }

      console.log(`MP4 processing completed: ${mp4Url}`);
    } catch (error) {
      console.error("MP4 processing failed:", error);
      // Don't throw error here - continue with HLS processing even if MP4 fails
      console.log("Continuing with HLS processing despite MP4 failure...");
    }
  }

  // Final check before S3 upload to ensure video wasn't completed by another process
  if (uploadId) {
    const currentRecord = getVideoRecord(uploadId);
    if (currentRecord && currentRecord.status === "completed") {
      console.log(
        `Video ${uploadId} was completed by another process, skipping S3 upload...`
      );
      return currentRecord.streamUrl || "";
    }
  }

  // Update progress before starting S3 upload (adjust based on transcoding strategy)
  if (uploadId) {
    // For stream copy, we can move to a higher progress faster since transcoding was quick
    const progressAfterTranscoding =
      codecInfo.recommendedStrategy === "copy" ? 85 : 80;
    updateVideoRecord(uploadId, { progress: progressAfterTranscoding });
  }

  await uploadFile(outputDir, s3Prefix, uploadId);

  if (uploadId) {
    updateVideoRecord(uploadId, { progress: 95 });
  }

  // Store metadata for later retrieval
  const metadataFile = path.join(outputDir, "metadata.json");
  const metadata = {
    name,
    packager: "ffmpeg",
    createdAt: new Date().toISOString(),
    source: path.basename(localPath),
    hasThumbnail: fs.existsSync(path.join(outputDir, "thumbnail.jpg")),
    transcodingStrategy: codecInfo?.recommendedStrategy || "reencode",
    sourceCodecs: {
      video: codecInfo?.videoCodec || "unknown",
      audio: codecInfo?.audioCodec || "unknown",
      profile: codecInfo?.videoProfile || "unknown",
    },
    hlsCompatible: codecInfo?.isHlsCompatible || false,
  };
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `${s3Prefix}/metadata.json`,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json",
      ACL: "public-read",
    })
  );

  return `${BUCKET_NAME}.${ENV.S3_ENDPOINT}/${s3Prefix}/index.m3u8`;
}

interface VideoInfo {
  url: string;
  name: string;
  packager?: string;
  createdAt?: string;
}

export async function listVideos(): Promise<VideoInfo[]> {
  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Delimiter: "/",
    });

    const { CommonPrefixes = [] } = await s3Client.send(command);
    const folders = CommonPrefixes.map((prefix) =>
      prefix.Prefix?.replace(/\/$/, "")
    ).filter((prefix): prefix is string => !!prefix);

    // Create a list of promises that fetch metadata for each video
    const videoInfoPromises = folders.map(async (folder) => {
      const videoInfo: VideoInfo = {
        url: `${BUCKET_NAME}.${ENV.S3_ENDPOINT}/${folder}/index.m3u8`,
        name: folder,
      };

      // Try to get metadata if it exists
      try {
        const metadataCommand = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `${folder}/metadata.json`,
        });

        const response = await s3Client.send(metadataCommand);
        if (response && response.Body) {
          // Convert stream to string
          const streamToString = async (stream: any): Promise<string> => {
            const chunks: Buffer[] = [];
            return new Promise((resolve, reject) => {
              stream.on("data", (chunk: Buffer) => chunks.push(chunk));
              stream.on("error", reject);
              stream.on("end", () =>
                resolve(Buffer.concat(chunks).toString("utf8"))
              );
            });
          };

          const body = await streamToString(response.Body);
          const metadata = JSON.parse(body);
          videoInfo.packager = metadata.packager;
          videoInfo.createdAt = metadata.createdAt;
        }
      } catch (err) {
        // Metadata doesn't exist or couldn't be retrieved - that's fine
        console.log(`No metadata found for ${folder}`);
      }

      return videoInfo;
    });

    return await Promise.all(videoInfoPromises);
  } catch (error) {
    console.error("Error listing videos:", error);
    throw new Error("Failed to list videos");
  }
}

/**
 * Detects the format of a video file using FFprobe
 * @param filePath - Path to the video file
 * @returns The container format (e.g., 'mov,mp4,m4a,3gp,3g2,mj2' for MP4)
 */
async function detectVideoFormat(filePath: string): Promise<string> {
  try {
    const cmd = `ffprobe -v quiet -show_format -select_streams v:0 -print_format json "${filePath}"`;
    const output = execSync(cmd, { encoding: "utf8" });
    const data = JSON.parse(output);
    return data.format?.format_name || "";
  } catch (error) {
    console.error("Error detecting video format:", error);
    throw new Error("Failed to detect video format");
  }
}

/**
 * Interface for video codec information
 */
interface VideoCodecInfo {
  videoCodec: string;
  audioCodec: string;
  videoProfile?: string;
  videoLevel?: string;
  containerFormat: string;
  isHlsCompatible: boolean;
  recommendedStrategy: "copy" | "selective" | "reencode";
}

/**
 * Probes video file to get detailed codec information
 * @param filePath - Path to the video file
 * @returns Detailed codec information and HLS compatibility
 */
async function probeVideoCodecs(filePath: string): Promise<VideoCodecInfo> {
  try {
    const cmd = `ffprobe -v quiet -show_streams -show_format -print_format json "${filePath}"`;
    const output = execSync(cmd, { encoding: "utf8" });
    const data = JSON.parse(output);

    let videoCodec = "";
    let audioCodec = "";
    let videoProfile = "";
    let videoLevel = "";

    // Find video and audio streams
    const videoStream = data.streams?.find(
      (stream: any) => stream.codec_type === "video"
    );
    const audioStream = data.streams?.find(
      (stream: any) => stream.codec_type === "audio"
    );

    if (videoStream) {
      videoCodec = videoStream.codec_name || "";
      videoProfile = videoStream.profile || "";
      videoLevel = videoStream.level || "";
    }

    if (audioStream) {
      audioCodec = audioStream.codec_name || "";
    }

    const containerFormat = data.format?.format_name || "";

    // Determine HLS compatibility and strategy
    const isHlsCompatible = isCompatibleWithHls(
      videoCodec,
      audioCodec,
      videoProfile
    );
    const recommendedStrategy = determineTranscodingStrategy(
      videoCodec,
      audioCodec,
      videoProfile
    );

    return {
      videoCodec,
      audioCodec,
      videoProfile,
      videoLevel,
      containerFormat,
      isHlsCompatible,
      recommendedStrategy,
    };
  } catch (error) {
    console.error("Error probing video codecs:", error);
    throw new Error("Failed to probe video codecs");
  }
}

/**
 * Determines if video/audio codecs are compatible with HLS
*  @param videoCodec - Video codec (e.g., 'h264')
*  @param audioCodec - Audio codec (e.g., 'aac')
*  @param videoProfile - Video profile (e.g., 'main', 'high')
 */
function isCompatibleWithHls(
  videoCodec: string,
  audioCodec: string,
  videoProfile?: string
): boolean {
  const isVideoCompatible =
    videoCodec === "h264" &&
    (!videoProfile ||
      ["baseline", "main", "high", "constrained baseline"].includes(
        videoProfile.toLowerCase()
      ));

  const isAudioCompatible = audioCodec === "aac";

  return isVideoCompatible && isAudioCompatible;
}

/**
 * Determines the best transcoding strategy based on codec compatibility
 */
function determineTranscodingStrategy(
  videoCodec: string,
  audioCodec: string,
  videoProfile?: string
): "copy" | "selective" | "reencode" {
  const isVideoH264Compatible =
    videoCodec === "h264" &&
    (!videoProfile ||
      ["baseline", "main", "high", "constrained baseline"].includes(
        videoProfile.toLowerCase()
      ));

  const isAudioAacCompatible = audioCodec === "aac";

  if (isVideoH264Compatible && isAudioAacCompatible) {
    return "copy"; // Full stream copy
  } else if (isVideoH264Compatible && !isAudioAacCompatible) {
    return "selective"; // Copy video, re-encode audio
  } else {
    return "reencode"; // Re-encode both video and audio
  }
}

/**
 * Builds optimized FFmpeg command based on transcoding strategy
 * @param strategy - Transcoding strategy ('copy', 'selective', or 'reencode')
 * @param inputPath - Input video file path
 * @param outputPath - Output HLS playlist path
 * @returns FFmpeg command string
 */
function buildOptimizedFFmpegCommand(
  strategy: "copy" | "selective" | "reencode",
  inputPath: string,
  outputPath: string
): string {
  const baseParams = "-start_number 0 -hls_time 3 -hls_list_size 0 -f hls";

  switch (strategy) {
    case "copy":
      // Full stream copy - fastest option
      return `ffmpeg -i "${inputPath}" -c copy ${baseParams} "${outputPath}"`;

    case "selective":
      // Copy video, re-encode audio to AAC
      return `ffmpeg -i "${inputPath}" -c:v copy -c:a aac -b:a 128k ${baseParams} "${outputPath}"`;

    case "reencode":
    default:
      // Full re-encode with optimized settings
      return `ffmpeg -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k ${baseParams} "${outputPath}"`;
  }
}

/**
 * Estimates processing time based on strategy and file size
 * @param strategy - Transcoding strategy
 * @param fileSizeBytes - File size in bytes
 * @returns Estimated processing time in seconds
 */
function estimateProcessingTime(
  strategy: "copy" | "selective" | "reencode",
  fileSizeBytes: number
): number {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  switch (strategy) {
    case "copy":
      return Math.max(2, fileSizeMB * 0.1); // ~0.1 seconds per MB
    case "selective":
      return Math.max(5, fileSizeMB * 0.3); // ~0.3 seconds per MB
    case "reencode":
    default:
      return Math.max(10, fileSizeMB * 2); // ~2 seconds per MB
  }
}

/**
 * Converts a video file to MP4 format using FFmpeg
 * @param inputPath - Input video file path
 * @param outputPath - Output MP4 file path
 * @param uploadId - Upload ID for progress tracking
 */
async function convertToMp4(
  inputPath: string,
  outputPath: string,
  uploadId?: string
): Promise<void> {
  try {
    console.log(`Converting video to MP4: ${inputPath} -> ${outputPath}`);

    // Use FFmpeg with optimized settings for web playback
    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -movflags +faststart -y "${outputPath}"`;

    console.log(`Executing MP4 conversion command: ${cmd}`);
    execSync(cmd, { stdio: "inherit" });

    console.log("MP4 conversion completed successfully");

    // Update progress if uploadId is provided
    if (uploadId) {
      updateVideoRecord(uploadId, { progress: 70 });
    }
  } catch (error) {
    console.error("Error converting video to MP4:", error);
    throw new Error("Failed to convert video to MP4");
  }
}

/**
 * Uploads an MP4 file to S3
 * @param filePath - Local path to the MP4 file
 * @param s3Key - S3 key (path) for the uploaded file
 * @param uploadId - Upload ID for progress tracking
 * @returns The S3 URL of the uploaded file
 */
async function uploadMp4ToS3(
  filePath: string,
  s3Key: string,
  uploadId?: string
): Promise<string> {
  try {
    console.log(`Uploading MP4 to S3: ${filePath} -> ${s3Key}`);

    const data = await fsPromises.readFile(filePath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: data,
        ContentType: "video/mp4",
        ACL: "public-read",
      })
    );

    console.log(`MP4 uploaded to S3 successfully: ${s3Key}`);

    // Update progress if uploadId is provided
    if (uploadId) {
      updateVideoRecord(uploadId, { progress: 85 });
    }

    return `${BUCKET_NAME}.${ENV.S3_ENDPOINT}/${s3Key}`;
  } catch (error) {
    console.error("Error uploading MP4 to S3:", error);
    throw new Error("Failed to upload MP4 to S3");
  }
}
