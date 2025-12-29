import { Router } from 'express';
import {
  authenticateSession,
  requireNotBanned,
  optionalSessionAuthenticate,
} from '../lib/sessionAuth.js';
import { likeComment, unlikeComment } from '../controllers/likeController.js';
import { getCommentReplies, deleteComment } from '../controllers/commentController.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.post(
  '/:commentId/like',
  authenticateSession,
  requireNotBanned,
  likeComment,
);
router.delete(
  '/:commentId/like',
  authenticateSession,
  requireNotBanned,
  unlikeComment,
);
router.delete(
  '/:commentId',
  authenticateSession,
  deleteComment
);

registerRoute({
  method: 'POST',
  path: '/comments/:commentId/like',
  summary: 'Like a comment',
  auth: true,
  params: { commentId: 'Comment ID' },
  responses: {
    '201': '{ "message": "Comment liked", "likeCount": 1 }',
    '404': '{ "error": "Comment not found" }',
    '409': '{ "error": "Comment already liked" }',
  },
});

registerRoute({
  method: 'DELETE',
  path: '/comments/:commentId/like',
  summary: 'Unlike a comment',
  auth: true,
  params: { commentId: 'Comment ID' },
  responses: {
    '200': '{ "message": "Comment unliked", "likeCount": 0 }',
    '404': '{ "error": "Like not found for this comment" }',
  },
});

router.get(
  '/:commentId/replies',
  optionalSessionAuthenticate,
  getCommentReplies,
);
registerRoute({
  method: 'GET',
  path: '/comments/:commentId/replies',
  summary: 'Get replies for a comment (paginated)',
  description:
    'Returns the direct replies of a comment. Use this endpoint recursively to implement infinite nested replies. Each reply includes likeCount, likedByMe (only when the request is authenticated), user (with proxied avatarUrl), and _count.replies to indicate if more nested replies are available.',
  params: { commentId: 'Parent comment ID' },
  query: {
    page: 'number (default 1)',
    limit: 'number (default 20)',
  },
  responses: {
    '200': `{
  "replies": [
    {
      "id": "string",
      "content": "string",
      "createdAt": "ISO8601",
      "updatedAt": "ISO8601",
      "likeCount": 2,
      "likedByMe": true,
      "user": { "id": "string", "username": "string", "displayName": "string|null", "avatarUrl": "http://localhost:2353/assets/users/<userId>/avatar/<file>" },
      "_count": { "replies": 3 }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 42, "totalPages": 3, "itemsReturned": 20 }
}`,
  },
});

export default router;
