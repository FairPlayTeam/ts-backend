import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedAssetUrl } from '../lib/utils.js';

export const addComment = async (
  req: SessionAuthRequest,
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

    // Proxy avatar URL in the response
    const transformed = {
      ...newComment,
      user: {
        ...newComment.user,
        avatarUrl: getProxiedAssetUrl(
          newComment.user.id,
          newComment.user.avatarUrl,
          'avatar',
        ),
      },
    };

    res.status(201).json({ message: 'Comment added', comment: transformed });
  } catch (error: any) {
    if (error?.code === 'P2003') {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
};

export const deleteComment = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const role = (req.user as any)?.role as string | undefined;
    const isStaff = role === 'moderator' || role === 'admin';

    const { commentId } = req.params as { commentId: string };

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        userId: true,
        _count: { select: { replies: true } },
      },
    });

    if (!comment) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const canDelete = comment.userId === userId || isStaff;
    if (!canDelete) {
      res.status(403).json({ error: 'Not allowed to delete this comment' });
      return;
    }

    if (comment._count.replies > 0) {
      await prisma.comment.update({
        where: { id: commentId },
        data: { content: '[deleted]' },
      });

      res.json({ message: 'Comment deleted (soft)' });
      return;
    }

    await prisma.$transaction([
      prisma.commentLike.deleteMany({
        where: { commentId },
      }),
      prisma.comment.delete({
        where: { id: commentId },
      }),
    ]);

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
};

export const getCommentReplies = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { commentId } = req.params as { commentId: string };
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);

    const parent = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true },
    });
    if (!parent) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const userSelect = {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
    };

    const [rows, total] = await Promise.all([
      prisma.comment.findMany({
        where: { parentId: commentId },
        select: {
          id: true,
          content: true,
          createdAt: true,
          updatedAt: true,
          likeCount: true,
          user: { select: userSelect },
          _count: { select: { replies: true } },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: Number(limit),
      }),
      prisma.comment.count({ where: { parentId: commentId } }),
    ]);

    const requesterId = (req as any).user?.id as string | undefined;
    let likedIds = new Set<string>();
    if (requesterId && rows.length > 0) {
      const ids = rows.map((c: any) => c.id);
      const likes = await prisma.commentLike.findMany({
        where: { userId: requesterId, commentId: { in: ids } },
        select: { commentId: true },
      });
      likedIds = new Set(likes.map((l) => l.commentId));
    }

    const replies = rows.map((r: any) => ({
      ...r,
      likedByMe: requesterId ? likedIds.has(r.id) : undefined,
      user: {
        ...r.user,
        avatarUrl: getProxiedAssetUrl(r.user.id, r.user.avatarUrl, 'avatar'),
      },
    }));

    res.json({
      replies,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: replies.length,
      },
    });
  } catch (error) {
    console.error('Get comment replies error:', error);
    res.status(500).json({ error: 'Failed to get comment replies' });
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
        select: {
          id: true,
          content: true,
          createdAt: true,
          updatedAt: true,
          likeCount: true,
          user: { select: userSelect },
          _count: { select: { replies: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.comment.count({ where: { videoId, parentId: null } }),
    ]);

    const requesterId = (req as any).user?.id as string | undefined;
    let likedIds = new Set<string>();
    if (requesterId && rows.length > 0) {
      const ids = rows.map((c: any) => c.id);
      const likes = await prisma.commentLike.findMany({
        where: { userId: requesterId, commentId: { in: ids } },
        select: { commentId: true },
      });
      likedIds = new Set(likes.map((l) => l.commentId));
    }

    const comments = rows.map((comment: any) => ({
      ...comment,
      likedByMe: requesterId ? likedIds.has(comment.id) : undefined,
      user: {
        ...comment.user,
        avatarUrl: getProxiedAssetUrl(
          comment.user.id,
          comment.user.avatarUrl,
          'avatar',
        ),
      },
    }));

    res.json({
      comments,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: comments.length,
      },
    });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
};
