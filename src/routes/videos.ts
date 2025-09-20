import { Router } from 'express';
import { authenticateToken, requireNotBanned } from '../lib/auth.js';
import {
  getVideos,
  getVideoById,
  getUserVideos,
  searchVideos,
  updateVideo,
} from '../controllers/videoController.js';
import { updateThumbnail } from '../controllers/uploadController.js';
import { rateVideo } from '../controllers/ratingController.js';
import { addComment, getComments } from '../controllers/commentController.js';
import { registerRoute } from '../lib/docs.js';
import {
  validate,
  commentSchema,
  updateVideoSchema,
} from '../middleware/validation.js';
import { upload } from '../middleware/upload.js';
import { validateFileMagicNumbers } from '../middleware/fileValidation.js';
import { z } from 'zod';

const router = Router();

router.get('/', getVideos);
registerRoute({
  method: 'GET',
  path: '/videos',
  summary: 'List publicly available videos',
  description:
    'Returns only videos that are approved, done processing, and public.',
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "videos": [
    {
      "id": "string",
      "title": "string",
      "thumbnailUrl": "string|null",
      "viewCount": "string",
      "avgRating": 4.5,
      "ratingsCount": 10,
      "user": { "username": "string", "displayName": "string|null" }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});
router.get('/my', authenticateToken, getUserVideos);
registerRoute({
  method: 'GET',
  path: '/videos/my',
  summary: 'List my videos',
  auth: true,
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "videos": [
    {
      "id": "string",
      "title": "string",
      "thumbnailUrl": "string|null",
      "viewCount": "string",
      "avgRating": 4.5,
      "ratingsCount": 10
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});
router.get('/:id', getVideoById);
router.patch(
  '/:id',
  authenticateToken,
  requireNotBanned,
  validate(updateVideoSchema),
  updateVideo,
);
router.post(
  '/:id/thumbnail',
  authenticateToken,
  requireNotBanned,
  upload.single('thumbnail'),
  validateFileMagicNumbers,
  updateThumbnail,
);

router.get('/search', searchVideos);
registerRoute({
  method: 'GET',
  path: '/videos/search',
  summary: 'Search publicly available videos',
  description:
    'Search only videos that are approved, done processing, public, and whose owners are not banned.',
  query: {
    q: 'string (query term)',
    page: 'number (default 1)',
    limit: 'number (default 20)',
  },
  responses: {
    '200': `{
  "videos": [
    { "id": "string", "title": "string", "thumbnailUrl": "string|null", "viewCount": "string", "avgRating": 4.5, "ratingsCount": 10, "user": { "username": "string", "displayName": "string|null" }, "createdAt": "ISO8601" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 },
  "query": { "q": "term" }
}`,
  },
});
registerRoute({
  method: 'GET',
  path: '/videos/:id',
  summary: 'Get video details',
  params: { id: 'Video ID' },
  responses: {
    '200': `{
  "id": "string",
  "title": "string",
  "hls": {
    "master": "string|null",
    "variants": {
      "240p": "string|null",
      "480p": "string|null",
      "720p": "string|null",
      "1080p": "string|null"
    },
    "available": ["1080p","720p"],
    "preferred": "1080p"
  },
  "thumbnailUrl": "string|null",
  "viewCount": "string",
  "avgRating": 4.5,
  "ratingsCount": 10
}`,
    '403': '{ "error": "Video not available" }',
    '404': '{ "error": "Video not found" }',
  },
});

registerRoute({
  method: 'PATCH',
  path: '/videos/:id',
  summary: 'Update video details',
  description:
    'Update the title, description, or visibility of a video. Only the video owner can perform this action.',
  auth: true,
  params: { id: 'Video ID' },
  body: {
    title: 'string (optional)',
    description: 'string (optional)',
    visibility: 'public | unlisted | private (optional)',
  },
  responses: {
    '200':
      '{ "message": "Video updated successfully", "video": { ..., "thumbnailUrl": "string|null" } }',
    '403': '{ "error": "You are not authorized to edit this video" }',
    '404': '{ "error": "Video not found" }',
  },
});

registerRoute({
  method: 'POST',
  path: '/videos/:id/thumbnail',
  summary: 'Update video thumbnail',
  description:
    'Upload a new thumbnail for a video. Only the video owner can perform this action.',
  auth: true,
  params: { id: 'Video ID' },
  body: { thumbnail: 'image file' },
  responses: {
    '200':
      '{ "message": "Thumbnail updated successfully", "thumbnailUrl": "string|null" }',
    '400': '{ "error": "No thumbnail file provided" }',
    '403': '{ "error": "You are not authorized to edit this video" }',
    '404': '{ "error": "Video not found" }',
  },
});

const ratingSchema = z.object({
  body: z.object({
    score: z.number().int().min(1).max(5),
  }),
});
router.post(
  '/:videoId/rating',
  authenticateToken,
  requireNotBanned,
  validate(ratingSchema),
  rateVideo,
);
registerRoute({
  method: 'POST',
  path: '/videos/:videoId/rating',
  summary: 'Rate a video',
  auth: true,
  params: { videoId: 'Video ID' },
  body: { score: 'number (1-5)' },
  responses: {
    '200': '{ "message": "Rating updated", ... }',
    '201': '{ "message": "Rating created", ... }',
    '404': '{ "error": "Video not found" }',
  },
});

router.post(
  '/:videoId/comments',
  authenticateToken,
  requireNotBanned,
  validate(commentSchema),
  addComment,
);
router.get('/:videoId/comments', getComments);

registerRoute({
  method: 'POST',
  path: '/videos/:videoId/comments',
  summary: 'Add a comment to a video',
  description:
    'To reply to another comment, include the `parentId` of the comment you are replying to in the request body.',
  auth: true,
  params: { videoId: 'Video ID' },
  body: {
    content: 'string (1-1000 chars)',
    parentId: 'string (optional UUID)',
  },
  responses: {
    '201': '{ "message": "Comment added", ... }',
    '404': '{ "error": "Video not found" }',
  },
});

registerRoute({
  method: 'GET',
  path: '/videos/:videoId/comments',
  summary: 'Get comments for a video',
  description:
    'Returns comments in a nested structure. The top-level array contains only parent comments. Replies are included in the `replies` array of each comment object.',
  params: { videoId: 'Video ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "comments": [
    {
      "id": "string",
      "content": "string",
      "createdAt": "ISO8601",
      "user": { "id": "string", "username": "string", ... },
      "replies": [
        {
          "id": "string",
          "content": "This is a reply.",
          "createdAt": "ISO8601",
          "user": { "id": "string", "username": "string", ... },
          "replies": []
        }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});

export default router;
