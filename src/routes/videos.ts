import { Router } from 'express';
import { authenticateSession, requireNotBanned } from '../lib/sessionAuth.js';
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
router.get('/my', authenticateSession, getUserVideos);
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
  authenticateSession,
  requireNotBanned,
  validate(updateVideoSchema),
  updateVideo,
);
router.post(
  '/:id/thumbnail',
  authenticateSession,
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
`{"message": "Video updated successfully", "video": {"id": "uuid", "title": "Updated Title", "description": "Updated description", "thumbnailUrl": "https://example.com/thumb.jpg"}}`,
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
  authenticateSession,
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
    '200': `{"message": "Rating updated", "rating": {"id": "uuid", "score": 4, "userId": "uuid", "videoId": "uuid"}}`,
    '201': `{"message": "Rating created", "rating": {"id": "uuid", "score": 5, "userId": "uuid", "videoId": "uuid"}}`,
    '404': '{ "error": "Video not found" }',
  },
});

router.post(
  '/:videoId/comments',
  authenticateSession,
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
    '201': `{"message": "Comment added", "comment": {"id": "uuid", "content": "Great video!", "userId": "uuid", "videoId": "uuid", "parentId": null, "likeCount": 0, "createdAt": "2024-09-20T13:30:00Z"}}`,
    '404': '{ "error": "Video not found" }',
  },
});

registerRoute({
  method: 'GET',
  path: '/videos/:videoId/comments',
  summary: 'Get comments for a video',
  description:
    'Returns comments in a nested structure. The top-level array contains only parent comments. Replies are included in the `replies` array of each comment object. Each comment (including replies and child replies) includes a `likeCount` field. The number of nested replies returned is capped by `repliesLimit` and `childRepliesLimit`. The `_count.replies` field indicates if more replies are available for a comment/reply so clients can implement "load more".',
  params: { videoId: 'Video ID' },
  query: {
    page: 'number (default 1)',
    limit: 'number (default 20)',
    repliesLimit: 'number (default 3) - max number of direct replies per parent comment',
    childRepliesLimit: 'number (default 2) - max number of replies per reply',
  },
  responses: {
    '200': `{
  "comments": [
    {
      "id": "string",
      "content": "string",
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601",
      "likeCount": 3,
      "user": {
        "id": "string",
        "username": "string",
        "displayName": "string|null",
        "avatarUrl": "http://localhost:2353/assets/users/<userId>/avatar/<file>"
      },
      "_count": { "replies": 5 },
      "replies": [
        {
          "id": "string",
          "content": "This is a reply.",
          "createdAt": "ISO8601",
          "updatedAt": "ISO8601",
          "likeCount": 2,
          "user": {
            "id": "string",
            "username": "string",
            "displayName": "string|null",
            "avatarUrl": "http://localhost:2353/assets/users/<userId>/avatar/<file>"
          },
          "_count": { "replies": 12 },
          "replies": [
            {
              "id": "string",
              "content": "This is a child reply.",
              "createdAt": "ISO8601",
              "updatedAt": "ISO8601",
              "likeCount": 1,
              "user": {
                "id": "string",
                "username": "string",
                "displayName": "string|null",
                "avatarUrl": "http://localhost:2353/assets/users/<userId>/avatar/<file>"
              },
              "_count": { "replies": 0 }
            }
          ]
        }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});

export default router;
