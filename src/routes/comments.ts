import { Router } from 'express';
import { authenticateToken, requireNotBanned } from '../lib/auth.js';
import { likeComment, unlikeComment } from '../controllers/likeController.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.post('/:commentId/like', authenticateToken, requireNotBanned, likeComment);
router.delete('/:commentId/like', authenticateToken, requireNotBanned, unlikeComment);

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

export default router;
