import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticateSession, requireModerator } from '../lib/sessionAuth.js';
import { registerRoute } from '../lib/docs.js';
import { createUserSearchWhere, getProxiedThumbnailUrl } from '../lib/utils.js';
import { validate, moderationSchema } from '../middleware/validation.js';

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const MODERATOR_VIDEO_SORT_FIELDS = ['createdAt', 'title'] as const;
const VIDEO_PROCESSING_STATUSES = ['uploading', 'processing', 'done'] as const;
const VIDEO_MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
const VIDEO_VISIBILITIES = ['public', 'unlisted', 'private'] as const;

type ModeratorVideoSortField = (typeof MODERATOR_VIDEO_SORT_FIELDS)[number];
type SortDirection = 'asc' | 'desc';
type ProcessingStatus = (typeof VIDEO_PROCESSING_STATUSES)[number];
type ModerationStatus = (typeof VIDEO_MODERATION_STATUSES)[number];
type Visibility = (typeof VIDEO_VISIBILITIES)[number];

const isModeratorVideoSortField = (value: string): value is ModeratorVideoSortField =>
  MODERATOR_VIDEO_SORT_FIELDS.includes(value as ModeratorVideoSortField);

const isProcessingStatus = (value: string): value is ProcessingStatus =>
  VIDEO_PROCESSING_STATUSES.includes(value as ProcessingStatus);

const isModerationStatus = (value: string): value is ModerationStatus =>
  VIDEO_MODERATION_STATUSES.includes(value as ModerationStatus);

const isVisibility = (value: string): value is Visibility =>
  VIDEO_VISIBILITIES.includes(value as Visibility);

const parsePageNumber = (value: string | undefined, fallback: number) =>
  Math.max(1, Number.parseInt(value ?? String(fallback), 10) || fallback);

const parseSortDirection = (value: string | undefined): SortDirection =>
  value === 'asc' ? 'asc' : 'desc';

const buildModeratorVideosWhere = ({
  processingStatus,
  moderationStatus,
  visibility,
  userId,
  search,
}: {
  processingStatus?: string;
  moderationStatus?: string;
  visibility?: string;
  userId?: string;
  search?: string;
}): Prisma.VideoWhereInput => {
  const where: Prisma.VideoWhereInput = {};

  if (processingStatus && isProcessingStatus(processingStatus)) {
    where.processingStatus = processingStatus;
  }

  if (moderationStatus && isModerationStatus(moderationStatus)) {
    where.moderationStatus = moderationStatus;
  }

  if (visibility && isVisibility(visibility)) {
    where.visibility = visibility;
  }

  if (userId) {
    where.user = createUserSearchWhere(userId);
  }

  if (search) {
    where.title = { contains: search, mode: 'insensitive' };
  }

  return where;
};

const buildModeratorVideosOrderBy = (
  sort: string | undefined,
): Prisma.VideoOrderByWithRelationInput => {
  const [rawField, rawDirection] = (sort ?? 'createdAt:desc').split(':');
  const field = isModeratorVideoSortField(rawField) ? rawField : 'createdAt';

  return {
    [field]: parseSortDirection(rawDirection),
  };
};

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
      limit = String(DEFAULT_PAGE_SIZE),
      sort = 'createdAt:desc',
    } = req.query as Record<string, string>;

    const pageNumber = parsePageNumber(page, 1);
    const limitNumber = parsePageNumber(limit, DEFAULT_PAGE_SIZE);
    const skip = (pageNumber - 1) * limitNumber;
    const where = buildModeratorVideosWhere({
      processingStatus,
      moderationStatus,
      visibility,
      userId,
      search,
    });
    const orderBy = buildModeratorVideosOrderBy(sort);

    const [rows, total] = await Promise.all([
      prisma.video.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, displayName: true } },
        },
        orderBy,
        skip,
        take: limitNumber,
      }),
      prisma.video.count({ where }),
    ]);

    const videosWithUrls = rows.map((video) => ({
      id: video.id,
      title: video.title,
      user: video.user,
      processingStatus: video.processingStatus,
      moderationStatus: video.moderationStatus,
      visibility: video.visibility,
      createdAt: video.createdAt,
      thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
    }));

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        totalItems: total,
        totalPages: Math.ceil(total / limitNumber),
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
    userId: 'Filter by owner username or ID (optional)',
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
        data: { moderationStatus },
        select: {
          id: true,
          title: true,
          moderationStatus: true,
          processingStatus: true,
        },
      });

      res.json({ message: 'Moderation updated', video: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        res.status(404).json({ error: 'Video not found' });
        return;
      }
      console.error('Moderator update moderation error:', error);
      res.status(500).json({ error: 'Failed to update video moderation' });
    }
  },
);

export default router;
