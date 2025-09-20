import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticateSession, requireModerator } from '../lib/sessionAuth.js';
import { getFileUrl, BUCKETS } from '../lib/minio.js';
import { registerRoute } from '../lib/docs.js';
import { validate, moderationSchema } from '../middleware/validation.js';

const router = Router();

router.use(authenticateSession);
router.use(requireModerator);

router.get('/videos', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      processingStatus,
      moderationStatus,
      visibility,
      userId,
      search,
      page = '1',
      limit = '20',
      sort = 'createdAt:desc',
    } = req.query as Record<string, string>;

    const [sortField, sortDir] = sort.split(':');

    const where: any = {};
    if (processingStatus) where.processingStatus = processingStatus;
    if (moderationStatus) where.moderationStatus = moderationStatus;
    if (visibility) where.visibility = visibility;
    if (userId) where.userId = userId;
    if (search) where.title = { contains: search, mode: 'insensitive' };

    const skip = (Number(page) - 1) * Number(limit);

    const [rows, total] = await Promise.all([
      prisma.video.findMany({
        where: where as any,
        include: {
          user: { select: { id: true, username: true, displayName: true } },
        },
        orderBy: {
          [sortField || 'createdAt']:
            (sortDir as any) === 'asc' ? 'asc' : 'desc',
        },
        skip,
        take: Number(limit),
      }),
      prisma.video.count({ where: where as any }),
    ]);

    const videosWithUrls = await Promise.all(
      rows.map(async (v: any) => ({
        id: v.id,
        title: v.title,
        user: v.user,
        processingStatus: v.processingStatus,
        moderationStatus: v.moderationStatus,
        visibility: v.visibility,
        createdAt: v.createdAt,
        thumbnailUrl: v.thumbnail ? await getFileUrl(BUCKETS.VIDEOS, v.thumbnail).catch(() => null) : null,
      })),
    );

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: videosWithUrls.length,
      },
    });
  } catch (error) {
    console.error('Moderator list videos error:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

registerRoute({
  method: 'GET',
  path: '/moderator/videos',
  summary: 'List videos for moderation',
  description:
    'Lists videos with advanced filters. Supports filtering by processingStatus, moderationStatus, visibility, owner, and title search. Supports pagination and sorting.',
  auth: true,
  roles: ['moderator', 'admin'],
  query: {
    processingStatus: 'uploading|processing|done (optional)',
    moderationStatus: 'pending|approved|rejected (optional)',
    visibility: 'public|unlisted|private (optional)',
    userId: 'Filter by owner (optional)',
    search: 'Case-insensitive substring in title (optional)',
    page: 'Page number (default 1)',
    limit: 'Items per page (default 20)',
    sort: 'field:dir (default createdAt:desc)',
  },
  responses: {
    '200': `{
  "videos": [
    {
      "id": "string",
      "title": "string",
      "user": { "id": "string", "username": "string", "displayName": "string|null" },
      "thumbnailUrl": "string|null",
      "processingStatus": "uploading|processing|done",
      "moderationStatus": "pending|approved|rejected",
      "visibility": "public|unlisted|private",
      "createdAt": "ISO8601"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 123, "totalPages": 7, "itemsReturned": 20 }
}`,
  },
});

registerRoute({
  method: 'PATCH',
  path: '/moderator/videos/:id/moderation',
  summary: 'Approve or reject a video',
  description:
    'Update only moderationStatus to approved or rejected for a video.',
  auth: true,
  roles: ['moderator', 'admin'],
  params: { id: 'Video ID' },
  body: { action: "'approve' | 'reject'" },
  responses: {
    '200': `{
  "message": "Moderation updated",
  "video": {
    "id": "string",
    "title": "string",
    "moderationStatus": "approved|rejected",
    "processingStatus": "uploading|processing|done"
  }
}`,
    '404': '{ "error": "Video not found" }',
  },
});

router.patch(
  '/videos/:id/moderation',
  validate(moderationSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { action } = req.body as { action?: string };

      if (!action || !['approve', 'reject'].includes(action)) {
        res.status(400).json({ error: "action must be 'approve' or 'reject'" });
        return;
      }

      const moderationStatus = action === 'approve' ? 'approved' : 'rejected';

      const updated = await prisma.video.update({
        where: { id },
        data: { moderationStatus } as any,
        select: {
          id: true,
          title: true,
          moderationStatus: true,
          processingStatus: true,
        },
      });

      res.json({ message: 'Moderation updated', video: updated });
    } catch (error: any) {
      if (error?.code === 'P2025') {
        res.status(404).json({ error: 'Video not found' });
        return;
      }
      console.error('Moderator update moderation error:', error);
      res.status(500).json({ error: 'Failed to update video moderation' });
    }
  },
);

export default router;
