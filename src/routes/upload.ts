import { Router } from 'express';
import { authenticateSession, requireNotBanned } from '../lib/sessionAuth.js';
import {
  uploadSingle,
  uploadVideoBundle as uploadVideoBundleFields,
  uploadChunkSingle,
} from '../middleware/upload.js';
import { validateFileMagicNumbers } from '../middleware/fileValidation.js';
import {
  uploadVideo,
  uploadVideoBundle,
  initChunkedVideoUpload,
  uploadVideoChunk,
  completeChunkedVideoUpload,
  abortChunkedVideoUpload,
  uploadAvatar,
  uploadBanner,
  getFileDownloadUrl,
} from '../controllers/uploadController.js';
import { registerRoute } from '../lib/docs.js';
import { chunkUploadLimiter, uploadLimiter } from '../middleware/limiters.js';
import {
  DIRECT_VIDEO_UPLOAD_MAX_MB,
  MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS,
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB,
  VIDEO_CHUNK_MB,
} from '../lib/uploadConfig.js';

const router = Router();

router.use(authenticateSession);
router.use(requireNotBanned);

router.post(
  '/video',
  uploadLimiter,
  uploadSingle('video'),
  validateFileMagicNumbers,
  uploadVideo,
);
registerRoute({
  method: 'POST',
  path: '/upload/video',
  summary: `Upload a video up to ${DIRECT_VIDEO_UPLOAD_MAX_MB}MB (queued for processing)`,
  auth: true,
  body: { title: 'string', description: 'string?', tags: 'string (comma-separated)', video: 'file' },
  responses: {
    '200': `{
  "message": "Video uploaded successfully and queued for processing",
  "video": {
    "id": "string",
    "title": "string"
  }
}`
  }
});

router.post('/video-chunks/init', uploadLimiter, initChunkedVideoUpload);
registerRoute({
  method: 'POST',
  path: '/upload/video-chunks/init',
  summary: `Initialize chunked video upload (up to ${MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB}MB total)`,
  auth: true,
  description: `Chunked uploads use fixed ${VIDEO_CHUNK_MB}MB chunks and are capped at ${MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS} chunks total to protect temporary disk usage.`,
  body: {
    title: 'string',
    description: 'string?',
    tags: 'string (comma-separated)?',
    allowComments: 'boolean (optional, default: true)',
    license: 'all_rights_reserved|cc_by|cc_by_sa|cc_by_nd|cc_by_nc|cc_by_nc_sa|cc_by_nc_nd|cc0 (optional)',
    totalSize: 'number (bytes)',
    totalChunks: 'number',
    originalName: 'string?',
    mimeType: 'string?',
  },
  responses: {
    '201': `{
  "uploadId": "uuid",
  "chunkSizeBytes": 99614720,
  "chunkSizeMB": 95,
  "totalChunks": 6,
  "totalSize": 624951296
}`,
  },
});

router.post(
  '/video-chunks/:uploadId/chunk',
  chunkUploadLimiter,
  uploadChunkSingle,
  uploadVideoChunk,
);
registerRoute({
  method: 'POST',
  path: '/upload/video-chunks/:uploadId/chunk',
  summary: 'Upload one video chunk (max safe chunk size from init response)',
  auth: true,
  params: { uploadId: 'Upload session ID (UUID)' },
  body: {
    chunkIndex: 'number (0-based)',
    chunk: `file (max ${VIDEO_CHUNK_MB}MB)`,
  },
  responses: {
    '200': `{
  "message": "Chunk uploaded successfully",
  "uploadId": "uuid",
  "chunkIndex": 0,
  "receivedChunks": 1,
  "totalChunks": 6,
  "isComplete": false
}`,
  },
});

router.post(
  '/video-chunks/:uploadId/complete',
  chunkUploadLimiter,
  completeChunkedVideoUpload,
);
registerRoute({
  method: 'POST',
  path: '/upload/video-chunks/:uploadId/complete',
  summary: 'Finalize chunked video upload and queue processing',
  auth: true,
  params: { uploadId: 'Upload session ID (UUID)' },
  responses: {
    '200': `{
  "message": "Video uploaded successfully and queued for processing",
  "video": {
    "id": "string",
    "title": "string"
  }
}`,
  },
});

router.delete(
  '/video-chunks/:uploadId',
  chunkUploadLimiter,
  abortChunkedVideoUpload,
);
registerRoute({
  method: 'DELETE',
  path: '/upload/video-chunks/:uploadId',
  summary: 'Abort a chunked video upload session and delete temporary chunks',
  auth: true,
  params: { uploadId: 'Upload session ID (UUID)' },
  responses: {
    '200': '{ "message": "Chunked upload aborted successfully" }',
  },
});

router.post(
  '/video-bundle',
  uploadLimiter,
  uploadVideoBundleFields,
  validateFileMagicNumbers,
  uploadVideoBundle,
);
registerRoute({
  method: 'POST',
  path: '/upload/video-bundle',
  summary: `Upload a video bundle up to ${DIRECT_VIDEO_UPLOAD_MAX_MB}MB with an optional thumbnail`,
  auth: true,
  body: {
    title: 'string',
    description: 'string?',
    tags: 'string (comma-separated)',
    allowComments: 'boolean (optional, default: true)',
    video: 'file',
    thumbnail: 'image file (optional)',
  },
  responses: {
    '200': `{
  "message": "Video uploaded successfully and queued for processing",
  "video": {
    "id": "string",
    "title": "string",
    "thumbnailUrl": "string|null"
  }
}`
  }
});

router.post(
  '/avatar',
  uploadSingle('avatar'),
  validateFileMagicNumbers,
  uploadAvatar,
);
registerRoute({
  method: 'POST',
  path: '/upload/avatar',
  summary: 'Upload user avatar',
  auth: true,
  body: { avatar: 'image file' },
  responses: {
    '200': `{
  "message": "Avatar uploaded successfully",
  "avatarUrl": "string"
}`
  }
});

router.post(
  '/banner',
  uploadSingle('banner'),
  validateFileMagicNumbers,
  uploadBanner,
);
registerRoute({
  method: 'POST',
  path: '/upload/banner',
  summary: 'Upload user banner',
  auth: true,
  body: { banner: 'image file' },
  responses: {
    '200': `{
  "message": "Banner uploaded successfully",
  "bannerUrl": "string"
}`
  }
});

router.get('/url/:bucket', getFileDownloadUrl);
router.get('/url/:bucket/*', getFileDownloadUrl);
registerRoute({
  method: 'GET',
  path: '/upload/url/:bucket',
  summary: 'Get a presigned URL for one of your stored objects',
  description:
    'Only the owning user or staff can request a presigned URL. Public assets and playback should use the proxy endpoints instead.',
  auth: true,
  params: { bucket: 'videos|users' },
  query: {
    objectName: 'Object path inside the bucket (preferred for nested paths)',
    expiry: 'Expiry in seconds between 60 and 604800 (optional)',
  },
  responses: {
    '200': '{ "url": "string", "expiresIn": 86400, "objectName": "user/video/file.ext" }',
    '403': '{ "error": "Access denied" }',
    '404': '{ "error": "Object not found" }',
  }
});

export default router;
