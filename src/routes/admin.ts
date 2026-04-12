import { Prisma } from '@prisma/client';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticateSession, requireAdmin } from '../lib/sessionAuth.js';
import { registerRoute } from '../lib/docs.js';
import { createUserSearchWhere } from '../lib/utils.js';
import {
  validate,
  banSchema,
  roleSchema,
  upsertCampaignSchema,
} from '../middleware/validation.js';
import { updateUserRole } from '../controllers/userController.js';
import { upsertCampaign } from '../controllers/campaignController.js';
import { getProxiedAssetUrl } from '../lib/utils.js';

const router = Router();

const DEFAULT_PAGE_SIZE = 20;
const ADMIN_USER_SORT_FIELDS = ['createdAt', 'username', 'email'] as const;

type AdminUserSortField = (typeof ADMIN_USER_SORT_FIELDS)[number];
type SortDirection = 'asc' | 'desc';

const isAdminUserSortField = (value: string): value is AdminUserSortField =>
  ADMIN_USER_SORT_FIELDS.includes(value as AdminUserSortField);

const parsePageNumber = (value: string | undefined, fallback: number) =>
  Math.max(1, Number.parseInt(value ?? String(fallback), 10) || fallback);

const parseSortDirection = (value: string | undefined): SortDirection =>
  value === 'asc' ? 'asc' : 'desc';

const buildAdminUsersWhere = ({
  search,
  isBanned,
}: {
  search?: string;
  isBanned?: string;
}): Prisma.UserWhereInput => {
  const where: Prisma.UserWhereInput = {};

  if (search) {
    where.OR = [
      { username: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (typeof isBanned !== 'undefined') {
    where.isBanned = isBanned === 'true';
  }

  return where;
};

const buildAdminUsersOrderBy = (sort: string | undefined): Prisma.UserOrderByWithRelationInput => {
  const [rawField, rawDirection] = (sort ?? 'createdAt:desc').split(':');
  const field = isAdminUserSortField(rawField) ? rawField : 'createdAt';

  return {
    [field]: parseSortDirection(rawDirection),
  };
};

router.use(authenticateSession);
router.use(requireAdmin);

router.get('/users', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      search,
      page = '1',
      limit = String(DEFAULT_PAGE_SIZE),
      sort = 'createdAt:desc',
      isBanned,
    } = req.query as Record<string, string>;

    const pageNumber = parsePageNumber(page, 1);
    const limitNumber = parsePageNumber(limit, DEFAULT_PAGE_SIZE);
    const skip = (pageNumber - 1) * limitNumber;
    const where = buildAdminUsersWhere({ search, isBanned });
    const orderBy = buildAdminUsersOrderBy(sort);

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          role: true,
          isActive: true,
          isVerified: true,
          isBanned: true,
          banReasonPrivate: true,
          createdAt: true,
        },
        orderBy,
        skip,
        take: limitNumber,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      users: rows.map((u) => ({
        ...u,
        avatarUrl: getProxiedAssetUrl(u.id, u.avatarUrl),
      })),
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        totalItems: total,
        totalPages: Math.ceil(total / limitNumber),
        itemsReturned: rows.length,
      },
    });
  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

registerRoute({
  method: 'GET',
  path: '/admin/users',
  summary: 'Admin: list users',
  description:
    'Lists users with optional search and ban filtering. Supports pagination and sorting.',
  auth: true,
  roles: ['admin'],
  query: {
    search: 'Search in username/email/displayName (optional)',
    isBanned: 'true|false (optional)',
    page: 'Page number (default 1)',
    limit: 'Items per page (default 20)',
    sort: 'field:dir (default createdAt:desc)',
  },
  responses: {
    '200': `{
  "users": [
    {
      "id": "string",
      "email": "string",
      "username": "string",
      "displayName": "string|null",
      "thumbnailUrl": "string|null",
      "role": "user|moderator|admin",
      "isActive": true,
      "isVerified": false,
      "isBanned": false,
      "banReasonPrivate": "string|null",
      "createdAt": "ISO8601"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "totalItems": 123, "totalPages": 7, "itemsReturned": 20 }
}`,
  },
});

router.get('/users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findFirst({
      where: createUserSearchWhere(id),
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        isVerified: true,
        isBanned: true,
        banReasonPrivate: true,
        bannedAt: true,
        createdAt: true,
        followerCount: true,
        followingCount: true,
        videoCount: true,
        totalViews: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl),
      role: user.role,
      isActive: user.isActive,
      isVerified: user.isVerified,
      isBanned: user.isBanned,
      banReasonPrivate: user.banReasonPrivate,
      bannedAt: user.bannedAt,
      createdAt: user.createdAt,
      followerCount: user.followerCount,
      followingCount: user.followingCount,
      videoCount: user.videoCount,
      totalViews: user.totalViews,
    });
  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

registerRoute({
  method: 'GET',
  path: '/admin/users/:id',
  summary: 'Admin: get user by username or ID',
  auth: true,
  roles: ['admin'],
  params: { id: 'Username or User ID' },
  responses: {
    '200': `{
  "id": "string",
  "email": "string",
  "username": "string",
  "displayName": "string|null",
  "thumbnailUrl": "string|null",
  "role": "user|moderator|admin",
  "isActive": true,
  "isVerified": false,
  "isBanned": false,
  "banReasonPrivate": "string|null",
  "bannedAt": "ISO8601|null",
  "createdAt": "ISO8601",
  "followerCount": 0,
  "followingCount": 0,
  "videoCount": 0,
  "totalViews": "string"
}`,
    '404': '{ "error": "User not found" }',
  },
});

router.patch('/users/:id/role', validate(roleSchema), updateUserRole);

registerRoute({
  method: 'PATCH',
  path: '/admin/users/:id/role',
  summary: 'Admin: update user role',
  auth: true,
  roles: ['admin'],
  params: { id: 'Username or User ID' },
  body: { role: 'user | moderator | admin' },
  responses: {
    '200': `{"message": "User role updated successfully", "user": {"id": "uuid", "username": "johndoe", "role": "moderator"}}`,
    '404': '{ "error": "User not found" }',
  },
});

router.patch(
  '/users/:id/ban',
  validate(banSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { isBanned, privateReason } = req.body as {
        isBanned?: boolean;
        privateReason?: string;
      };

      if (typeof isBanned !== 'boolean') {
        res.status(400).json({ error: 'isBanned must be boolean' });
        return;
      }

      const user = await prisma.user.findFirst({
        where: createUserSearchWhere(id),
        select: { id: true },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const data: Prisma.UserUpdateInput = {
        isBanned,
        banReasonPrivate: privateReason ?? null,
        bannedAt: isBanned ? new Date() : null,
      };

      const updated = await prisma.user.update({
        where: { id: user.id },
        data,
        select: {
          id: true,
          username: true,
          isBanned: true,
          banReasonPrivate: true,
          bannedAt: true,
        },
      });

      res.json({
        message: isBanned ? 'User banned' : 'User unbanned',
        user: updated,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      console.error('Admin ban user error:', error);
      res.status(500).json({ error: 'Failed to update user ban status' });
    }
  },
);

registerRoute({
  method: 'PATCH',
  path: '/admin/users/:id/ban',
  summary: 'Admin: ban or unban a user',
  description:
    'Ban or unban a user with optional public and private reasons. Sets bannedAt when banning.',
  auth: true,
  roles: ['admin'],
  params: { id: 'Username or User ID' },
  body: {
    isBanned: 'boolean',
    publicReason: 'string?',
    privateReason: 'string?',
  },
  responses: {
    '200': `{
  "message": "User banned|User unbanned",
  "user": {
    "id": "string",
    "username": "string",
    "isBanned": true,
    "banReasonPrivate": "string|null",
    "bannedAt": "ISO8601|null"
  }
}`,
    '404': '{ "error": "User not found" }',
  },
});

router.put('/campaign', validate(upsertCampaignSchema), upsertCampaign);

registerRoute({
  method: 'PUT',
  path: '/admin/campaign',
  summary: 'Admin: create or update the active advertising campaign',
  description:
    'Upserts the singleton campaign record. Only one campaign can exist at a time.',
  auth: true,
  roles: ['admin'],
  body: {
    title: 'string',
    description: 'string',
    link: 'http(s) URL',
    thumbnailUrl: 'http(s) URL',
  },
  responses: {
    '200': `{
  "message": "Campaign updated successfully",
  "campaign": {
    "id": "active",
    "title": "string",
    "description": "string",
    "link": "https://example.com",
    "thumbnailUrl": "https://example.com/banner.jpg",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601",
    "updatedBy": {
      "id": "uuid",
      "username": "admin",
      "role": "admin"
    }
  }
}`,
    '403': '{ "error": "Admin access required" }',
  },
});

export default router;
