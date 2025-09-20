import { Router } from 'express';
import { authenticateToken, requireNotBanned } from '../lib/auth.js';
import {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
} from '../controllers/followController.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.post('/:followingId', authenticateToken, requireNotBanned, followUser);
registerRoute({
  method: 'POST',
  path: '/follow/:followingId',
  summary: 'Follow a user',
  auth: true,
  params: { followingId: 'User ID to follow' },
  responses: { '204': 'Success', '409': 'Already following' },
});

router.delete(
  '/:followingId',
  authenticateToken,
  requireNotBanned,
  unfollowUser,
);
registerRoute({
  method: 'DELETE',
  path: '/follow/:followingId',
  summary: 'Unfollow a user',
  auth: true,
  params: { followingId: 'User ID to unfollow' },
  responses: { '204': 'Success', '404': 'Not following' },
});

router.get('/:id/followers', getFollowers);
registerRoute({
  method: 'GET',
  path: '/user/:id/followers',
  summary: "Get a user's followers",
  params: { id: 'User ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "followers": [
    { "id": "string", "username": "string", "displayName": "string|null", "avatarUrl": "string|null" }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100 }
}`,
  },
});

router.get('/:id/following', getFollowing);
registerRoute({
  method: 'GET',
  path: '/user/:id/following',
  summary: 'Get users someone is following',
  params: { id: 'User ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "following": [
    { "id": "string", "username": "string", "displayName": "string|null", "avatarUrl": "string|null" }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100 }
}`,
  },
});

export default router;
