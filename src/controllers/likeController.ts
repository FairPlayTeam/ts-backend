import { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from '../lib/auth.js';

export const likeComment = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user!.id;
  const { commentId } = req.params;

  try {
    const existingLike = await prisma.commentLike.findUnique({
      where: {
        userId_commentId: {
          userId,
          commentId,
        },
      },
    });

    if (existingLike) {
      res.status(409).json({ error: 'Comment already liked' });
      return;
    }

    const [, comment] = await prisma.$transaction([
      prisma.commentLike.create({
        data: {
          userId,
          commentId,
        },
      }),
      prisma.comment.update({
        where: { id: commentId },
        data: {
          likeCount: {
            increment: 1,
          },
        },
      }),
    ]);

    res.status(201).json({ message: 'Comment liked', likeCount: comment.likeCount });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    console.error('Like comment error:', error);
    res.status(500).json({ error: 'Failed to like comment' });
  }
};

export const unlikeComment = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user!.id;
  const { commentId } = req.params;

  try {
    const [, comment] = await prisma.$transaction([
      prisma.commentLike.delete({
        where: {
          userId_commentId: {
            userId,
            commentId,
          },
        },
      }),
      prisma.comment.update({
        where: { id: commentId },
        data: {
          likeCount: {
            decrement: 1,
          },
        },
      }),
    ]);

    res.status(200).json({ message: 'Comment unliked', likeCount: comment.likeCount });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      res.status(404).json({ error: 'Like not found for this comment' });
      return;
    }
    console.error('Unlike comment error:', error);
    res.status(500).json({ error: 'Failed to unlike comment' });
  }
};
