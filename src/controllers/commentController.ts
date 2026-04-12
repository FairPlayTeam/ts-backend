import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedAssetUrl } from '../lib/utils.js';
import { isUUID } from '../lib/utils.js';

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 20;

const getOptionalUserId = (req: Request): string | undefined =>
    (req as SessionAuthRequest).user?.id;

const parsePagination = (query: Record<string, string>) => {
    const page = Math.max(1, parseInt(query.page ?? '1') || 1);
    const limit = Math.min(
        MAX_PAGE_LIMIT,
        Math.max(1, parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT)) || DEFAULT_PAGE_LIMIT)
    );
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

const userSelect = {
    id: true,
    username: true,
    displayName: true,
    avatarUrl: true,
};

type DeleteCommentResult = {
    message: string;
    deletionMode: 'soft' | 'hard';
    commentId: string;
};

export const addComment = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId } = req.params;
        const { content, parentId } = req.body;

        if (!isUUID(videoId)) {
            res.status(400).json({ error: 'Invalid video ID format' });
            return;
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { id: true, allowComments: true },
        });
        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        if (!video.allowComments) {
            res.status(403).json({ error: 'Comments are disabled for this video' });
            return;
        }

        if (parentId) {
            if (!isUUID(parentId)) {
                res.status(400).json({ error: 'Invalid parent comment ID format' });
                return;
            }
            const parent = await prisma.comment.findUnique({
                where: { id: parentId },
                select: { id: true, videoId: true },
            });
            if (!parent) {
                res.status(404).json({ error: 'Parent comment not found' });
                return;
            }
            if (parent.videoId !== videoId) {
                res.status(400).json({ error: 'Parent comment does not belong to this video' });
                return;
            }
        }

        const newComment = await prisma.comment.create({
            data: {
                userId,
                videoId,
                content,
                parentId: parentId ?? null,
            },
            include: {
                user: { select: userSelect },
            },
        });

        res.status(201).json({
            message: 'Comment added',
            comment: {
                ...newComment,
                user: {
                    ...newComment.user,
                    avatarUrl: getProxiedAssetUrl(newComment.user.id, newComment.user.avatarUrl),
                },
            },
        });
    } catch (error) {
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
        const role = req.user?.role as string | undefined;
        const isStaff = role === 'moderator' || role === 'admin';
        const { commentId } = req.params;

        if (!isUUID(commentId)) {
            res.status(400).json({ error: 'Invalid comment ID format' });
            return;
        }

        const comment = await prisma.comment.findUnique({
            where: { id: commentId },
            select: {
                id: true,
                userId: true,
                isDeleted: true,
                _count: { select: { replies: true } },
            },
        });

        if (!comment || comment.isDeleted) {
            res.status(404).json({ error: 'Comment not found' });
            return;
        }

        if (comment.userId !== userId && !isStaff) {
            res.status(403).json({ error: 'Not allowed to delete this comment' });
            return;
        }

        if (comment._count.replies > 0) {
            await prisma.comment.update({
                where: { id: commentId },
                data: { isDeleted: true, content: '[deleted]' },
            });
            const result: DeleteCommentResult = {
                message: 'Comment soft deleted',
                deletionMode: 'soft',
                commentId,
            };
            res.json(result);
            return;
        }

        await prisma.$transaction([
            prisma.commentLike.deleteMany({ where: { commentId } }),
            prisma.comment.delete({ where: { id: commentId } }),
        ]);

        const result: DeleteCommentResult = {
            message: 'Comment deleted',
            deletionMode: 'hard',
            commentId,
        };
        res.json(result);
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
        const { commentId } = req.params;

        if (!isUUID(commentId)) {
            res.status(400).json({ error: 'Invalid comment ID format' });
            return;
        }

        const { page, limit, skip } = parsePagination(req.query as Record<string, string>);

        const parent = await prisma.comment.findUnique({
            where: { id: commentId },
            select: { id: true },
        });
        if (!parent) {
            res.status(404).json({ error: 'Comment not found' });
            return;
        }

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
                take: limit,
            }),
            prisma.comment.count({ where: { parentId: commentId } }),
        ]);

        const requesterId = getOptionalUserId(req);
        let likedIds = new Set<string>();
        if (requesterId && rows.length > 0) {
            const likes = await prisma.commentLike.findMany({
                where: { userId: requesterId, commentId: { in: rows.map((c) => c.id) } },
                select: { commentId: true },
            });
            likedIds = new Set(likes.map((l) => l.commentId));
        }

        res.json({
            replies: rows.map((r) => ({
                ...r,
                likedByMe: requesterId ? likedIds.has(r.id) : undefined,
                user: {
                    ...r.user,
                    avatarUrl: getProxiedAssetUrl(r.user.id, r.user.avatarUrl),
                },
            })),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit),
                itemsReturned: rows.length,
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

        if (!isUUID(videoId)) {
            res.status(400).json({ error: 'Invalid video ID format' });
            return;
        }

        const { page, limit, skip } = parsePagination(req.query as Record<string, string>);

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
                take: limit,
            }),
            prisma.comment.count({ where: { videoId, parentId: null } }),
        ]);

        const requesterId = getOptionalUserId(req);
        let likedIds = new Set<string>();
        if (requesterId && rows.length > 0) {
            const likes = await prisma.commentLike.findMany({
                where: { userId: requesterId, commentId: { in: rows.map((c) => c.id) } },
                select: { commentId: true },
            });
            likedIds = new Set(likes.map((l) => l.commentId));
        }

        res.json({
            comments: rows.map((comment) => ({
                ...comment,
                likedByMe: requesterId ? likedIds.has(comment.id) : undefined,
                user: {
                    ...comment.user,
                    avatarUrl: getProxiedAssetUrl(comment.user.id, comment.user.avatarUrl),
                },
            })),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit),
                itemsReturned: rows.length,
            },
        });
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ error: 'Failed to get comments' });
    }
};
