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

const router = Router();

router.use(authenticateSession);
router.use(requireNotBanned);

router.post(
  '/video',
  uploadSingle('video'),
  validateFileMagicNumbers,
  uploadVideo,
);
registerRoute({
  method: 'POST',
  path: '/upload/video',
  summary: 'Upload a video (queued for processing)',
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

router.post('/video-chunks/init', initChunkedVideoUpload);
registerRoute({
  method: 'POST',
  path: '/upload/video-chunks/init',
  summary: 'Initialize chunked video upload (100MB chunks)',
  auth: true,
  body: {
    title: 'string',
    description: 'string?',
    tags: 'string (comma-separated)?',
    totalSize: 'number (bytes)',
    totalChunks: 'number',
    originalName: 'string?',
    mimeType: 'string?',
  },
  responses: {
    '201': `{
  "uploadId": "uuid",
  "chunkSizeBytes": 104857600,
  "chunkSizeMB": 100,
  "totalChunks": 6,
  "totalSize": 624951296
}`,
  },
});

router.post('/video-chunks/:uploadId/chunk', uploadChunkSingle, uploadVideoChunk);
registerRoute({
  method: 'POST',
  path: '/upload/video-chunks/:uploadId/chunk',
  summary: 'Upload one video chunk (max 100MB)',
  auth: true,
  params: { uploadId: 'Upload session ID (UUID)' },
  body: {
    chunkIndex: 'number (0-based)',
    chunk: 'file (max 100MB)',
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

router.post('/video-chunks/:uploadId/complete', completeChunkedVideoUpload);
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

router.delete('/video-chunks/:uploadId', abortChunkedVideoUpload);
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
  uploadVideoBundleFields,
  validateFileMagicNumbers,
  uploadVideoBundle,
);
registerRoute({
  method: 'POST',
  path: '/upload/video-bundle',
  summary: 'Upload a video with an optional thumbnail (queued for processing)',
  auth: true,
  body: {
    title: 'string',
    description: 'string?',
    tags: 'string (comma-separated)',
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

router.get('/url/:bucket/:filename', getFileDownloadUrl);
registerRoute({
  method: 'GET',
  path: '/upload/url/:bucket/:filename',
  summary: 'Get presigned URL for object',
  auth: true,
  params: { bucket: 'videos|users', filename: 'string' },
  responses: { '200': '{ "url": "string", "expiresIn": 86400 }' }
});

export default router;
