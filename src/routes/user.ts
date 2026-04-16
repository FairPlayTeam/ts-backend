import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { registerRoute } from '../lib/docs.js';
import {
  createUserSearchWhere,
  getProxiedAssetUrl,
  getProxiedThumbnailUrl,
} from '../lib/utils.js';
import {
  getFollowers,
  getFollowing,
  followUser,
  unfollowUser,
} from '../controllers/followController.js';
import {
  authenticateSession,
  requireNotBanned,
  optionalSessionAuthenticate,
  SessionAuthRequest,
} from '../lib/sessionAuth.js';
import { getTopCreators } from '../controllers/userController.js';
import { isStaffRole } from '../lib/videoAccess.js';
import { parsePagination } from '../lib/pagination.js';
import { getPublicVideoId } from '../lib/videoIds.js';

const router = Router();

router.get('/top/creators', getTopCreators);
registerRoute({
  method: 'GET',
  path: '/user/top/creators',
  summary: 'Get the 3 most followed creators',
  description: 'Returns the top 3 non-banned users with at least 1 video, ordered by followerCount (descending).',
  responses: {
    '200': `{"users": [{"id":"string","username":"string","displayName":"string|null","avatarUrl":"string|null","followerCount":0,"followingCount":0,"videoCount":0,"createdAt":"2024-09-20T13:30:00Z"}]}`,
  },
});

router.get(
  '/:id',
  optionalSessionAuthenticate,
  async (req: SessionAuthRequest, res: Response): Promise<void> => {
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
          isBanned: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const avatarUrl = getProxiedAssetUrl(user.id, user.avatarUrl);
      const bannerUrl = getProxiedAssetUrl(user.id, user.bannerUrl);

      const requesterId = req.user?.id;
      const requesterRole = req.user?.role;
      const canViewBannedUser = requesterId === user.id || isStaffRole(requesterRole);

      if (user.isBanned && !canViewBannedUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      let isFollowing: boolean | undefined = undefined;
      if (requesterId && requesterId !== user.id) {
        const follow = await prisma.follow.findFirst({
          where: { followerId: requesterId, followingId: user.id },
          select: { id: true },
        });
        isFollowing = Boolean(follow);
      }

      const { isBanned: _isBanned, ...publicUser } = user;
      const responseBody: {
        avatarUrl: string | null;
        bannerUrl: string | null;
        bio: string | null;
        createdAt: Date;
        displayName: string | null;
        followerCount: number;
        followingCount: number;
        id: string;
        username: string;
        videoCount: number;
        isFollowing?: boolean;
      } = { ...publicUser, avatarUrl, bannerUrl };
      if (requesterId) {
        responseBody.isFollowing = isFollowing ?? false;
      }

      res.json(responseBody);
    } catch (error) {
      console.error('Get user profile error:', error);
      res.status(500).json({ error: 'Failed to get user profile' });
    }
  },
);

registerRoute({
  method: 'GET',
  path: '/user/:id',
  summary: 'Get a public user profile by username or ID',
  description:
    'When the request is authenticated, the response additionally includes `isFollowing` indicating whether the current user follows this profile.',
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
  "createdAt": "ISO8601",
  "isFollowing": true
}`,
    '404': '{ "error": "User not found" }',
  },
});

router.get(
  '/:id/videos',
  optionalSessionAuthenticate,
    async (req: SessionAuthRequest, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { page, limit, skip } = parsePagination(req.query, {
        defaultLimit: 20,
        maxLimit: 50,
      });

      const user = await prisma.user.findFirst({
        where: createUserSearchWhere(id),
        select: { id: true, isBanned: true },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const canViewBannedUser =
        req.user?.id === user.id || isStaffRole(req.user?.role);

      if (user.isBanned && !canViewBannedUser) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const [rows, total] = await Promise.all([
        prisma.video.findMany({
          where: {
            userId: user.id,
            processingStatus: 'done',
            moderationStatus: 'approved',
            visibility: 'public',
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            publicId: true,
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
            processingStatus: 'done',
            moderationStatus: 'approved',
            visibility: 'public',
          },
        }),
      ]);

      const videos = await Promise.all(
        rows.map(async (v) => {
          const thumbUrl = getProxiedThumbnailUrl(user.id, v.id, v.thumbnail);
          return {
            id: getPublicVideoId(v),
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
          page,
          limit,
          totalItems: total,
          totalPages: Math.ceil(total / limit),
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

router.get('/:id/followers', optionalSessionAuthenticate, getFollowers);
router.get('/:id/following', optionalSessionAuthenticate, getFollowing);

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
