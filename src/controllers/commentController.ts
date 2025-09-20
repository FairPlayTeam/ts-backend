import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from '../lib/auth.js';

export const addComment = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { videoId } = req.params;
    const { content, parentId } = req.body;

    const newComment = await prisma.comment.create({
      data: {
        userId,
        videoId,
        content,
        parentId,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    res.status(201).json({ message: 'Comment added', comment: newComment });
  } catch (error: any) {
    if (error?.code === 'P2003') {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

export const getComments = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { videoId } = req.params;
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    const userSelect = {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    };

    const [rows, total] = await Promise.all([
      prisma.comment.findMany({
        where: { videoId, parentId: null },
        include: {
          user: { select: userSelect },
          replies: {
            include: {
              user: { select: userSelect },
              replies: {
                include: {
                  user: { select: userSelect },
                },
                orderBy: { createdAt: 'asc' },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.comment.count({ where: { videoId, parentId: null } }),
    ]);

    const nestedComments = rows;

    res.json({
      comments: nestedComments,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: nestedComments.length,
      },
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
};
