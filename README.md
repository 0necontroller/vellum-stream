# Vellum

Vellum is a pluggable video processing server that can be easily integrated into any application. It provides a Docker-based solution for handling video uploads, processing, and streaming with support for resumable uploads using TUS protocol.

## 🚀 Features

- **Dual Upload Methods**:
  - **TUS Protocol**: Resumable uploads (max 100MB) for reliable upload experience
  - **Direct Upload**: Fast multipart form uploads (max 200MB) for immediate processing
- **FFmpeg Transcoding**: Automatic video transcoding to HLS streaming format
- **S3 Compatible Storage**: Works with MinIO, AWS S3, or any S3-compatible storage
- **Queue-based Processing**: RabbitMQ-powered background video processing
- **REST API**: Complete API for video management with OpenAPI documentation
- **Webhook Callbacks**: Optional notifications when video processing completes
- **Bearer Token Authentication**: Secure API access with configurable API keys
- **Docker Ready**: Full Docker Compose setup with all dependencies

## 📋 Prerequisites

- Docker and Docker Compose
- At least 2GB RAM for video processing
- Sufficient disk space for temporary video storage

## 🛠️ Installation & Setup

### 1. Clone the Repository

```bash
git clone https://github.com/0necontroller/vellum.git
cd vellum
```

### 2. Configure Environment

Copy the example environment file and customize it:

```bash
cp .env.example .env
```

Edit `.env` with your environments:

```bash
# Server Configuration
SERVER_PORT=8001
NODE_ENV=production

# Upload Configuration
UPLOAD_PATH=./uploads
MAX_FILE_SIZE=100mb
ALLOWED_FILE_TYPES=video/mp4,video/avi,video/mov,video/mkv
MAX_FILES=10

# S3/MinIO Configuration
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_ENDPOINT=http://minio:9000
S3_BUCKET=video-streams

# MinIO Configuration
MINIO_API_PORT=9000
MINIO_CONSOLE_PORT=9001

# RabbitMQ Configuration
RABBITMQ_DEFAULT_USER=guest
RABBITMQ_DEFAULT_PASS=guest

# API Authentication
API_KEY=your_secure_api_key_here
```

### 3. Start the Services

```bash
docker-compose up -d
```

This will start:

- **Vellum API Server** on port 8001
- **MinIO S3 Storage** on port 9000 (API) and 9001 (Console)
- **RabbitMQ** on port 5672 (API) and 15672 (Management UI)

### 4. Verify Installation

Check that all services are running:

```bash
docker-compose ps
```

Access the API documentation at: `http://localhost:8001/api/v1/docs`

## 📚 API Usage

### Authentication

All API endpoints require Bearer token authentication. Include your API key in the Authorization header:

```bash
Authorization: Bearer your_secure_api_key_here
```

### Core Endpoints

#### 1. Create Upload Session

Create an upload session for a video file with your preferred upload method:

```bash
POST /api/v1/video/create
Content-Type: application/json
Authorization: Bearer your_secure_api_key_here

{
  "filename": "my-video.mp4",
  "filesize": 104857600,
  "type": "tus", // "tus" for resumable uploads (max 100MB) or "direct" for form uploads (max 200MB)
  "callbackUrl": "https://myapp.com/webhook", // optional
  "s3Path": "/v2/media", // optional - custom S3 path for storing the video
  "uploadToS3": true // optional - also upload MP4 version to S3
}
```

Response:

```json
{
  "status": "success",
  "message": "Upload session created",
  "data": {
    "uploadId": "550e8400-e29b-41d4-a716-446655440000",
    "uploadUrl": "http://localhost:8001/api/v1/tus/files/550e8400-e29b-41d4-a716-446655440000", // TUS endpoint for resumable uploads
    "videoUrl": "http://localhost:9000/video-streams/v2/media/550e8400-e29b-41d4-a716-446655440000/index.m3u8",
    "expiresIn": 3600,
    "mp4Url": "http://localhost:9000/video-streams/v2/media/550e8400-e29b-41d4-a716-446655440000/video.mp4" // included if uploadToS3 is true
  }
}
```

**For Direct Uploads** (type: "direct"):

```json
{
  "status": "success",
  "message": "Upload session created",
  "data": {
    "uploadId": "550e8400-e29b-41d4-a716-446655440000",
    "uploadUrl": "http://localhost:8001/api/v1/video/550e8400-e29b-41d4-a716-446655440000/upload", // Direct upload endpoint
    "videoUrl": "http://localhost:9000/video-streams/v2/media/550e8400-e29b-41d4-a716-446655440000/index.m3u8",
    "expiresIn": 3600
  }
}
```

**Response Fields:**

- `uploadId`: Unique identifier for the upload session
- `uploadUrl`: Upload endpoint URL (TUS for resumable uploads or direct endpoint for form uploads)
- `videoUrl`: Future HLS streaming URL where the processed video will be available
- `expiresIn`: Upload session expiration time in seconds
- `mp4Url`: Future MP4 file URL (only included if uploadToS3 is true)

#### 2. Upload Video File

Vellum supports two upload methods:

##### Option A: TUS Resumable Upload (Recommended for large files)

Use the TUS protocol for reliable, resumable uploads up to 100MB. Perfect for unstable network conditions:

```javascript
import * as tus from "tus-js-client";

const upload = new tus.Upload(file, {
  endpoint: "http://localhost:8001/api/v1/tus/files/",
  uploadUrl: uploadUrl, // from create session response
  retryDelays: [0, 3000, 5000, 10000, 20000],
  metadata: {
    filename: file.name,
    filetype: file.type,
  },
  onError: (error) => {
    console.error("Upload failed:", error);
  },
  onProgress: (bytesUploaded, bytesTotal) => {
    const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
    console.log(`Upload progress: ${percentage}%`);
  },
  onSuccess: () => {
    console.log("Upload completed successfully!");
  },
});

upload.start();
```

##### Option B: Direct Form Upload (Faster for smaller files)

Use direct multipart form upload for immediate processing up to 200MB:

```javascript
// JavaScript example
const formData = new FormData();
formData.append("file", fileInput.files[0]);

fetch(uploadUrl, {
  // uploadUrl from create session response
  method: "POST",
  headers: {
    Authorization: "Bearer your_secure_api_key_here",
  },
  body: formData,
})
  .then((response) => response.json())
  .then((data) => {
    console.log("Upload completed:", data);
  })
  .catch((error) => {
    console.error("Upload failed:", error);
  });
```

```bash
# cURL example
curl -X POST http://localhost:8001/api/v1/video/{uploadId}/upload \
  -H "Authorization: Bearer your_secure_api_key_here" \
  -F "file=@my-video.mp4"
```

**Upload Method Comparison:**

| Feature           | TUS Upload                         | Direct Upload                     |
| ----------------- | ---------------------------------- | --------------------------------- |
| **Max File Size** | 100MB                              | 200MB                             |
| **Resumable**     | ✅ Yes                             | ❌ No                             |
| **Speed**         | Moderate                           | Fast                              |
| **Reliability**   | High                               | Moderate                          |
| **Best For**      | Unstable connections, larger files | Stable connections, quick uploads |

#### 3. Check Video Status

Monitor the processing status of your video:

```bash
GET /api/v1/video/{uploadId}/status
Authorization: Bearer your_secure_api_key_here
```

Response:

```json
{
  "status": "success",
  "message": "Video status retrieved successfully",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "my-video.mp4",
    "status": "completed", // uploading, processing, completed, failed
    "progress": 100,
    "streamUrl": "http://localhost:9000/video-streams/550e8400.../playlist.m3u8",
    "createdAt": "2025-01-15T10:30:00Z",
    "completedAt": "2025-01-15T10:35:00Z"
  }
}
```

#### 4. List All Videos

Get a list of all processed videos:

```bash
GET /api/v1/videos
Authorization: Bearer your_secure_api_key_here
```

#### 5. Check Callback Status

Monitor webhook delivery status:

```bash
GET /api/v1/video/{uploadId}/callback-status
Authorization: Bearer your_secure_api_key_here
```

### Additional Endpoints

#### Direct File Upload

For direct uploads, use this endpoint after creating a session with `type: "direct"`:

```bash
POST /api/v1/video/{uploadId}/upload
Content-Type: multipart/form-data
Authorization: Bearer your_secure_api_key_here

# Form field: file (binary video file)
```

Response:

```json
{
  "status": "success",
  "message": "File uploaded successfully, processing started",
  "data": {
    "uploadId": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "my-video.mp4",
    "status": "processing"
  }
}
```

### Custom S3 Storage Paths

You can specify a custom path within your S3 bucket where videos should be stored using the `s3Path` parameter when creating an upload session.

**Default behavior** (without s3Path):

- Videos are stored directly in the bucket root: `video-streams/{videoId}/`
- Stream URL: `http://localhost:9000/video-streams/{videoId}/index.m3u8`

**With custom s3Path** (e.g., `"s3Path": "/v2/media"`):

- Videos are stored under the custom path: `video-streams/v2/media/{videoId}/`
- Stream URL: `http://localhost:9000/video-streams/v2/media/{videoId}/index.m3u8`

**Path Requirements:**

- Must contain only alphanumeric characters, forward slashes, hyphens, and underscores
- Leading and trailing slashes are automatically handled
- Examples: `/v2/media`, `client123/videos`, `year/2025/january`

**Use Cases:**

- **Multi-tenant applications**: `/tenant-{id}/videos`
- **API versioning**: `/v2/media`, `/v3/content`
- **Organizational structure**: `/department/marketing/videos`
- **Date-based organization**: `/2025/january/uploads`

## 🎬 Video Processing Workflow

### TUS Upload Workflow

1. **Upload Session Creation**: Client creates upload session via API with `type: "tus"`
2. **TUS Upload**: Client uploads video file using TUS protocol (resumable, max 100MB)
3. **Queue Processing**: Video is queued for background processing upon upload completion
4. **FFmpeg Transcoding**: Video is transcoded to HLS format
5. **S3 Upload**: Processed segments uploaded to S3/MinIO
6. **Webhook Notification**: Optional callback sent to your URL
7. **Cleanup**: Original video file deleted from disk

### Direct Upload Workflow

1. **Upload Session Creation**: Client creates upload session via API with `type: "direct"`
2. **Direct Upload**: Client uploads video file via multipart form (fast, max 200MB)
3. **Immediate Processing**: Video is immediately queued for background processing
4. **FFmpeg Transcoding**: Video is transcoded to HLS format
5. **S3 Upload**: Processed segments uploaded to S3/MinIO
6. **Webhook Notification**: Optional callback sent to your URL
7. **Cleanup**: Original video file deleted from disk

## 🔧 Development

### Local Development Setup

1. Install dependencies:

```bash
npm install
```

2. Start development services (MinIO + RabbitMQ):

```bash
docker-compose -f docker-compose.override.yml up -d minio rabbitmq
```

3. Start the development server:

```bash
npm run dev
```

### Available Scripts

```bash
npm run dev    # Start development server with hot reload
npm run build  # Build TypeScript to JavaScript
npm run start  # Start production server
```

## 🐳 Docker Configuration

### Environment Variables

| Variable             | Description                | Default                                   |
| -------------------- | -------------------------- | ----------------------------------------- |
| `SERVER_PORT`        | API server port            | `8001`                                    |
| `NODE_ENV`           | Environment mode           | `dev`                                     |
| `UPLOAD_PATH`        | Temporary upload directory | `./uploads`                               |
| `MAX_FILE_SIZE`      | Maximum file size (TUS)    | `100mb`                                   |
| `ALLOWED_FILE_TYPES` | Allowed MIME types         | `video/mp4,video/avi,video/mov,video/mkv` |
| `S3_ACCESS_KEY`      | S3/MinIO access key        | `minioadmin`                              |
| `S3_SECRET_KEY`      | S3/MinIO secret key        | `minioadmin`                              |
| `S3_ENDPOINT`        | S3/MinIO endpoint URL      | `http://minio:9000`                       |
| `S3_BUCKET`          | Storage bucket name        | `video-streams`                           |
| `API_KEY`            | Bearer token for API auth  | `your_api_key_here`                       |

### Custom Docker Compose

For production, you may want to:

1. Use external S3 service instead of MinIO
2. Use managed RabbitMQ service
3. Add reverse proxy (nginx/traefik)
4. Configure SSL certificates
5. Set up monitoring and logging

## 🔐 Security Considerations

- Change default API keys in production
- Use strong, unique API keys
- Enable HTTPS in production
- Restrict CORS origins
- Monitor API usage and rate limiting
- Regularly update Docker images

## 📊 Monitoring & Management

### MinIO Console

Access MinIO management interface at: `http://localhost:9001`

- Username: `minioadmin` (or your `S3_ACCESS_KEY`)
- Password: `minioadmin` (or your `S3_SECRET_KEY`)

### RabbitMQ Management

Access RabbitMQ management interface at: `http://localhost:15672`

- Username: `guest` (or your `RABBITMQ_DEFAULT_USER`)
- Password: `guest` (or your `RABBITMQ_DEFAULT_PASS`)

### API Documentation

Interactive API docs available at: `http://localhost:8001/api/v1/docs`

## 🐛 Troubleshooting

### Common Issues

**Video processing fails:**

- Check Docker container logs: `docker-compose logs app`
- Ensure sufficient disk space and RAM
- Verify FFmpeg is available in container

**Upload fails:**

- **TUS uploads**: Check TUS endpoint configuration, verify file size limits (100MB), ensure stable connection
- **Direct uploads**: Check multipart form configuration, verify file size limits (200MB), ensure proper Content-Type headers
- Verify file types are in allowed list
- Check available disk space in upload directory

**Upload type selection:**

- **Use TUS** for: Unstable networks, files close to limits, need for resumability
- **Use Direct** for: Fast networks, smaller files, immediate processing needs
- **File size limits**: TUS (100MB), Direct (200MB)

**Size limit errors:**

- TUS uploads: "File size exceeds maximum allowed size (100MB)"
- Direct uploads: "File size exceeds maximum allowed size for direct uploads (200MB)"
- Check file size before creating upload session

**Webhook callbacks fail:**

- Ensure callback URL is accessible
- Check callback endpoint returns 200 status
- Monitor callback retry attempts

**Storage issues:**

- Verify MinIO/S3 credentials
- Check bucket permissions
- Ensure bucket exists

### Logs

View application logs:

```bash
docker-compose logs -f app
```

View all service logs:

```bash
docker-compose logs -f
```

## 📋 Quick Reference

### Upload Type Comparison

| Upload Type | Max Size | Method           | Resumable | Best For                            |
| ----------- | -------- | ---------------- | --------- | ----------------------------------- |
| **TUS**     | 100MB    | `type: "tus"`    | ✅ Yes    | Unstable connections, reliability   |
| **Direct**  | 200MB    | `type: "direct"` | ❌ No     | Fast networks, immediate processing |

### API Endpoints

| Method | Endpoint                             | Description             |
| ------ | ------------------------------------ | ----------------------- |
| `POST` | `/api/v1/video/create`               | Create upload session   |
| `POST` | `/api/v1/video/{id}/upload`          | Direct file upload      |
| `GET`  | `/api/v1/video/{id}/status`          | Check processing status |
| `GET`  | `/api/v1/video/{id}/callback-status` | Check webhook status    |
| `GET`  | `/api/v1/videos`                     | List all videos         |
| `POST` | `/api/v1/tus/files/{id}`             | TUS upload endpoint     |

### Size Limits

- **Express payload limit**: 200MB (JSON/form data)
- **TUS uploads**: 100MB (configurable via `MAX_FILE_SIZE`)
- **Direct uploads**: 200MB (hardcoded for optimal performance)
- **Video processing**: No additional limits beyond upload constraints

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License.
