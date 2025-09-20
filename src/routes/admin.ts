import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authenticateToken, requireAdmin } from '../lib/auth.js';
import { registerRoute } from '../lib/docs.js';
import { validate, banSchema, roleSchema } from '../middleware/validation.js';
import { updateUserRole } from '../controllers/userController.js';

const router = Router();

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/users', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      search,
      page = '1',
      limit = '20',
      sort = 'createdAt:desc',
      isBanned,
    } = req.query as Record<string, string>;

    const [sortField, sortDir] = (sort || 'createdAt:desc').split(':');

    const where: any = {};
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (typeof isBanned !== 'undefined') where.isBanned = isBanned === 'true';

    const skip = (Number(page) - 1) * Number(limit);

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where: where as any,
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          role: true,
          isActive: true,
          isVerified: true,
          isBanned: true,
          banReasonPublic: true,
          createdAt: true,
        },
        orderBy: {
          [sortField || 'createdAt']:
            (sortDir as any) === 'asc' ? 'asc' : 'desc',
        },
        skip,
        take: Number(limit),
      }),
      prisma.user.count({ where: where as any }),
    ]);

    res.json({
      users: rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
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
      "role": "user|moderator|admin",
      "isActive": true,
      "isVerified": false,
      "isBanned": false,
      "banReasonPublic": "string|null",
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
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        role: true,
        isActive: true,
        isVerified: true,
        isBanned: true,
        banReasonPublic: true,
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
    res.json(user);
  } catch (error) {
    console.error('Admin get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

registerRoute({
  method: 'GET',
  path: '/admin/users/:id',
  summary: 'Admin: get user by id',
  auth: true,
  roles: ['admin'],
  params: { id: 'User ID' },
  responses: {
    '200': `{
  "id": "string",
  "email": "string",
  "username": "string",
  "displayName": "string|null",
  "role": "user|moderator|admin",
  "isActive": true,
  "isVerified": false,
  "isBanned": false,
  "banReasonPublic": "string|null",
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
  params: { id: 'User ID' },
  body: { role: 'user | moderator | admin' },
  responses: {
    '200': '{ "message": "User role updated successfully", ... }',
    '404': '{ "error": "User not found" }',
  },
});

router.patch(
  '/users/:id/ban',
  validate(banSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const { isBanned, publicReason, privateReason } = req.body as {
        isBanned?: boolean;
        publicReason?: string;
        privateReason?: string;
      };

      if (typeof isBanned !== 'boolean') {
        res.status(400).json({ error: 'isBanned must be boolean' });
        return;
      }

      const data: any = {
        isBanned,
        banReasonPublic: publicReason ?? null,
        banReasonPrivate: privateReason ?? null,
        bannedAt: isBanned ? new Date() : null,
      };

      const updated = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true,
          username: true,
          isBanned: true,
          banReasonPublic: true,
          banReasonPrivate: true,
          bannedAt: true,
        },
      });

      res.json({
        message: isBanned ? 'User banned' : 'User unbanned',
        user: updated,
      });
    } catch (error: any) {
      if (error?.code === 'P2025') {
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
  params: { id: 'User ID' },
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
    "banReasonPublic": "string|null",
    "banReasonPrivate": "string|null",
    "bannedAt": "ISO8601|null"
  }
}`,
    '404': '{ "error": "User not found" }',
  },
});

export default router;
