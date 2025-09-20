import { Router } from 'express';
import { authenticateSession, requireNotBanned } from '../lib/sessionAuth.js';
import { uploadSingle } from '../middleware/upload.js';
import { validateFileMagicNumbers } from '../middleware/fileValidation.js';
import {
  uploadVideo,
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
  "storagePath": "string",
  "size": 12345,
  "mimetype": "image/png"
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
  "storagePath": "string",
  "size": 12345,
  "mimetype": "image/png"
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
