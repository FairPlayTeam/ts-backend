import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';

export const followUser = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const followerId = req.user!.id;
    const { id: followingId } = req.params;

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
    const { id: followingId } = req.params;

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.follow.delete({
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
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followingId: id },
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
        take: Number(limit),
      }),
      prisma.follow.count({ where: { followingId: id } }),
    ]);

    res.json({
      followers: rows.map((r) => r.follower),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
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
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: id },
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
        take: Number(limit),
      }),
      prisma.follow.count({ where: { followerId: id } }),
    ]);

    res.json({
      following: rows.map((r) => r.following),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: rows.length,
      },
    });
  } catch (error) {
    console.error('Get following error:', error);
    res.status(500).json({ error: 'Failed to get following list' });
  }
};
