import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getProxiedThumbnailUrl } from '../lib/utils.js';
import { registerRoute } from '../lib/docs.js';
import { createUserSearchWhere, getProxiedAssetUrl } from '../lib/utils.js';
import {
  getFollowers,
  getFollowing,
  followUser,
  unfollowUser,
} from '../controllers/followController.js';
import { authenticateSession, requireNotBanned } from '../lib/sessionAuth.js';

const router = Router();

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findFirst({
      where: createUserSearchWhere(id),
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        bannerUrl: true,
        bio: true,
        followerCount: true,
        followingCount: true,
        videoCount: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const avatarUrl = getProxiedAssetUrl(user.id, user.avatarUrl, 'avatar');
    const bannerUrl = getProxiedAssetUrl(user.id, user.bannerUrl, 'banner');

    res.json({ ...user, avatarUrl, bannerUrl });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

registerRoute({
  method: 'GET',
  path: '/user/:id',
  summary: 'Get a public user profile by username or ID',
  params: { id: 'Username or User ID' },
  responses: {
    '200': `{
  "id": "string",
  "username": "string",
  "displayName": "string|null",
  "avatarUrl": "string|null",
  "bannerUrl": "string|null",
  "bio": "string|null",
  "followerCount": 0,
  "followingCount": 0,
  "videoCount": 0,
  "createdAt": "ISO8601"
}`,
    '404': '{ "error": "User not found" }',
  },
});

router.get(
  '/:id/videos',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { page = '1', limit = '20' } = req.query as Record<string, string>;
      const skip = (Number(page) - 1) * Number(limit);

      const user = await prisma.user.findFirst({
        where: createUserSearchWhere(id),
        select: { id: true },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const [rows, total] = await Promise.all([
        prisma.video.findMany({
          where: {
            userId: user.id,
            processingStatus: 'done' as any,
            moderationStatus: 'approved' as any,
            visibility: 'public' as any,
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: Number(limit),
          select: {
            id: true,
            title: true,
            description: true,
            thumbnail: true,
            createdAt: true,
            viewCount: true,
          },
        }),
        prisma.video.count({
          where: {
            userId: user.id,
            processingStatus: 'done' as any,
            moderationStatus: 'approved' as any,
            visibility: 'public' as any,
          },
        }),
      ]);

      const videos = await Promise.all(
        rows.map(async (v) => {
          const thumbUrl = getProxiedThumbnailUrl(user.id, v.id, v.thumbnail);
          return {
            id: v.id,
            title: v.title,
            description: v.description,
            createdAt: v.createdAt,
            viewCount: v.viewCount.toString(),
            thumbnailUrl: thumbUrl,
          };
        }),
      );

      res.json({
        videos,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          totalItems: total,
          totalPages: Math.ceil(total / Number(limit)),
          itemsReturned: videos.length,
        },
      });
    } catch (error) {
      console.error('Get user videos error:', error);
      res.status(500).json({ error: 'Failed to get user videos' });
    }
  },
);

registerRoute({
  method: 'GET',
  path: '/user/:id/videos',
  summary: "List a user's public videos",
  params: { id: 'Username or User ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "videos": [
    { "id": "string", "title": "string", "description": "string|null", "createdAt": "ISO8601", "viewCount": "string", "thumbnailUrl": "string|null" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 10, "totalPages": 1, "itemsReturned": 10 }
}`,
  },
});

router.get('/:id/followers', getFollowers);
router.get('/:id/following', getFollowing);

registerRoute({
  method: 'GET',
  path: '/user/:id/followers',
  summary: "Get a user's followers",
  params: { id: 'Username or User ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "followers": [
    { "id": "string", "username": "string", "displayName": "string|null", "avatarUrl": "string|null" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});

registerRoute({
  method: 'GET',
  path: '/user/:id/following',
  summary: 'Get users someone is following',
  params: { id: 'Username or User ID' },
  query: { page: 'number (default 1)', limit: 'number (default 20)' },
  responses: {
    '200': `{
  "following": [
    { "id": "string", "username": "string", "displayName": "string|null", "avatarUrl": "string|null" }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 100, "totalPages": 5, "itemsReturned": 20 }
}`,
  },
});

router.post('/:id/follow', authenticateSession, requireNotBanned, followUser);
router.delete(
  '/:id/follow',
  authenticateSession,
  requireNotBanned,
  unfollowUser,
);

registerRoute({
  method: 'POST',
  path: '/user/:id/follow',
  summary: 'Follow a user',
  auth: true,
  params: { id: 'Username or User ID to follow' },
  responses: {
    '204': 'No content',
    '409': `{"error": "Already following this user"}`,
  },
});

registerRoute({
  method: 'DELETE',
  path: '/user/:id/follow',
  summary: 'Unfollow a user',
  auth: true,
  params: { id: 'Username or User ID to unfollow' },
  responses: {
    '204': 'No content',
    '404': `{"error": "Not following this user"}`,
  },
});

export default router;
