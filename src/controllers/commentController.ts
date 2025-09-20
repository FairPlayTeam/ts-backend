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
    const {
      page = '1',
      limit = '20',
      repliesLimit = '3',
      childRepliesLimit = '2',
    } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);
    const repliesTake = Math.max(0, Number(repliesLimit));
    const childRepliesTake = Math.max(0, Number(childRepliesLimit));

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
          user: { select: userSelect },
          _count: { select: { replies: true } },
          replies: {
            orderBy: { createdAt: 'asc' },
            take: repliesTake,
            select: {
              id: true,
              content: true,
              createdAt: true,
              updatedAt: true,
              user: { select: userSelect },
              _count: { select: { replies: true } },
              replies: {
                orderBy: { createdAt: 'asc' },
                take: childRepliesTake,
                select: {
                  id: true,
                  content: true,
                  createdAt: true,
                  updatedAt: true,
                  user: { select: userSelect },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.comment.count({ where: { videoId, parentId: null } }),
    ]);

    const transformComment = (comment: any): any => ({
      ...comment,
      user: {
        ...comment.user,
        avatarUrl: getProxiedAssetUrl(
          comment.user.id,
          comment.user.avatarUrl,
          'avatar',
        ),
      },
      replies: comment.replies?.map((reply: any) => ({
        ...reply,
        user: {
          ...reply.user,
          avatarUrl: getProxiedAssetUrl(
            reply.user.id,
            reply.user.avatarUrl,
            'avatar',
          ),
        },
        replies: reply.replies?.map((childReply: any) => ({
          ...childReply,
          user: {
            ...childReply.user,
            avatarUrl: getProxiedAssetUrl(
              childReply.user.id,
              childReply.user.avatarUrl,
              'avatar',
            ),
          },
        })),
      })),
    });

    const nestedComments = rows.map(transformComment);

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
