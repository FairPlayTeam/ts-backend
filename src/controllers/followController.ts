import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { createUserSearchWhere, getProxiedAssetUrl } from '../lib/utils.js';

const MAX_PAGE_LIMIT = 50
const DEFAULT_PAGE_LIMIT = 20

const parsePagination = (query: Record<string, string>) => {
    const page = Math.max(1, parseInt(query.page ?? '1') || 1)
    const limit = Math.min(
        MAX_PAGE_LIMIT,
        Math.max(1, parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT)) || DEFAULT_PAGE_LIMIT)
    )
    return { page, limit, skip: (page - 1) * limit }
}

const isValidUserParam = (id: string): boolean =>
    typeof id === 'string' && id.length > 0 && id.length <= 100

export const followUser = async (
	req: SessionAuthRequest,
	res: Response,
): Promise<void> => {
	try {
		const followerId = req.user!.id;
		const { id } = req.params;

		if (!isValidUserParam(id)) {
            res.status(400).json({ error: 'Invalid user identifier' })
            return
        }

		const userToFollow = await prisma.user.findFirst({
			where: createUserSearchWhere(id),
			select: { id: true },
		});

		if (!userToFollow) {
			res.status(404).json({ error: 'User not found' });
			return;
		}

		const followingId = userToFollow.id;

		if (followerId === followingId) {
			res.status(400).json({ error: 'You cannot follow yourself' });
			return;
		}

		await prisma.$transaction(async (tx) => {
			await tx.follow.create({
				data: {
					followerId,
					followingId,
				},
			});

			await tx.user.update({
				where: { id: followerId },
				data: { followingCount: { increment: 1 } },
			});
			await tx.user.update({
				where: { id: followingId },
				data: { followerCount: { increment: 1 } },
			});
		});

		res.status(204).send();
	} catch (error: any) {
		if (error?.code === 'P2002') {
			res.status(409).json({ error: 'You are already following this user' });
			return;
		}
		if (error?.code === 'P2025') {
			res.status(404).json({ error: 'User to follow not found' });
			return;
		}
		console.error('Follow user error:', error);
		res.status(500).json({ error: 'Failed to follow user' });
	}
};

export const unfollowUser = async (
	req: SessionAuthRequest,
	res: Response,
): Promise<void> => {
	try {
		const followerId = req.user!.id;
		const { id } = req.params;

		if (!isValidUserParam(id)) {
            res.status(400).json({ error: 'Invalid user identifier' })
            return
        }

		const userToUnfollow = await prisma.user.findFirst({
			where: createUserSearchWhere(id),
			select: { id: true },
		});

		if (!userToUnfollow) {
			res.status(404).json({ error: 'User not found' });
			return;
		}

		const followingId = userToUnfollow.id;

		await prisma.$transaction(async (tx) => {
			await tx.follow.delete({
				where: {
					followerId_followingId: {
						followerId,
						followingId,
					},
				},
			});

			await tx.user.update({
				where: { id: followerId },
				data: { followingCount: { decrement: 1 } },
			});
			await tx.user.update({
				where: { id: followingId },
				data: { followerCount: { decrement: 1 } },
			});
		});

		res.status(204).send();
	} catch (error: any) {
		if (error?.code === 'P2025') {
		res.status(404).json({ error: 'You are not following this user' });
		return;
		}
		console.error('Unfollow user error:', error);
		res.status(500).json({ error: 'Failed to unfollow user' });
	}
};

export const getFollowers = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

	if (!isValidUserParam(id)) {
		res.status(400).json({ error: 'Invalid user identifier' })
		return
	}

    const { page, limit, skip } = parsePagination(req.query as Record<string, string>);

    const user = await prisma.user.findFirst({
      where: createUserSearchWhere(id),
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: user.id },
        include: {
          follower: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.follow.count({ where: { followingId: user.id } }),
    ]);

    res.json({
      followers: rows.map((r) => ({
        ...r.follower,
        avatarUrl: getProxiedAssetUrl(
          r.follower.id,
          r.follower.avatarUrl,
        ),
      })),
      pagination: {
        page: page,
        limit: limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        itemsReturned: rows.length,
      },
    });
  } catch (error) {
    console.error('Get followers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
};

export const getFollowing = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

	if (!isValidUserParam(id)) {
		res.status(400).json({ error: 'Invalid user identifier' })
		return
	}

    const { page, limit, skip } = parsePagination(req.query as Record<string, string>)

    const user = await prisma.user.findFirst({
      where: createUserSearchWhere(id),
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: user.id },
        include: {
          following: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.follow.count({ where: { followerId: user.id } }),
    ]);

    res.json({
      following: rows.map((r) => ({
        ...r.following,
        avatarUrl: getProxiedAssetUrl(
          r.following.id,
          r.following.avatarUrl,
        ),
      })),
      pagination: {
        page: page,
        limit: limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        itemsReturned: rows.length,
      },
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following list' });
  }
};
