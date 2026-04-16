import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedAssetUrl } from '../lib/utils.js';
import { isUUID } from '../lib/utils.js';
import { canAccessVideo } from '../lib/videoAccess.js';
import { parsePagination as parseRequestPagination } from '../lib/pagination.js';
import { resolveVideoByIdentifier } from '../lib/videoIds.js';

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 20;

const getOptionalUserId = (req: Request): string | undefined =>
    (req as SessionAuthRequest).user?.id;

const userSelect = {
    id: true,
    username: true,
    displayName: true,
    avatarUrl: true,
};

const videoAccessSelect = {
    userId: true,
    visibility: true,
    processingStatus: true,
    moderationStatus: true,
    user: {
        select: {
            isBanned: true,
        },
    },
} as const;

type DeleteCommentResult = {
    message: string;
    deletionMode: 'soft' | 'hard';
    commentId: string;
};

const commentListSelect = {
    id: true,
    content: true,
    createdAt: true,
    updatedAt: true,
    likeCount: true,
    user: { select: userSelect },
    _count: { select: { replies: true } },
} as const;

type CommentListRow = {
    id: string;
    content: string;
    createdAt: Date;
    updatedAt: Date;
    likeCount: number;
    user: {
        id: string;
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
    };
    _count: {
        replies: number;
    };
};

const getLikedCommentIds = async (
    requesterId: string | undefined,
    commentIds: string[],
): Promise<Set<string>> => {
    if (!requesterId || commentIds.length === 0) {
        return new Set();
    }

    const likes = await prisma.commentLike.findMany({
        where: {
            userId: requesterId,
            commentId: { in: commentIds },
        },
        select: { commentId: true },
    });

    return new Set(likes.map((like) => like.commentId));
};

const mapCommentListItems = (
    rows: CommentListRow[],
    requesterId: string | undefined,
    likedIds: Set<string>,
) =>
    rows.map((row) => ({
        ...row,
        likedByMe: requesterId ? likedIds.has(row.id) : undefined,
        user: {
            ...row.user,
            avatarUrl: getProxiedAssetUrl(row.user.id, row.user.avatarUrl),
        },
    }));

export const addComment = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId } = req.params;
        const { content, parentId } = req.body;

        const video = await resolveVideoByIdentifier(videoId, {
            id: true,
            allowComments: true,
            ...videoAccessSelect,
        });
        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        if (!canAccessVideo(video, req.user)) {
            res.status(403).json({ error: 'Video not available' });
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
            if (parent.videoId !== video.id) {
                res.status(400).json({ error: 'Parent comment does not belong to this video' });
                return;
            }
        }

        const newComment = await prisma.comment.create({
            data: {
                userId,
                videoId: video.id,
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
            await prisma.$transaction([
                prisma.commentLike.deleteMany({
                    where: { commentId },
                }),
                prisma.comment.update({
                    where: { id: commentId },
                    data: {
                        isDeleted: true,
                        content: '[deleted]',
                        likeCount: 0,
                    },
                }),
            ]);
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

        const { page, limit, skip } = parseRequestPagination(req.query, {
            defaultLimit: DEFAULT_PAGE_LIMIT,
            maxLimit: MAX_PAGE_LIMIT,
        });

        const parent = await prisma.comment.findUnique({
            where: { id: commentId },
            select: {
                id: true,
                video: {
                    select: videoAccessSelect,
                },
            },
        });
        if (!parent) {
            res.status(404).json({ error: 'Comment not found' });
            return;
        }

        if (!canAccessVideo(parent.video, (req as SessionAuthRequest).user ?? null)) {
            res.status(403).json({ error: 'Video not available' });
            return;
        }

        const [rows, total] = await Promise.all([
            prisma.comment.findMany({
                where: { parentId: commentId },
                select: commentListSelect,
                orderBy: { createdAt: 'asc' },
                skip,
                take: limit,
            }),
            prisma.comment.count({ where: { parentId: commentId } }),
        ]);

        const requesterId = getOptionalUserId(req);
        const likedIds = await getLikedCommentIds(
            requesterId,
            rows.map((comment) => comment.id),
        );

        res.json({
            replies: mapCommentListItems(rows, requesterId, likedIds),
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

        const video = await resolveVideoByIdentifier(videoId, {
            id: true,
            ...videoAccessSelect,
        });

        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        if (!canAccessVideo(video, (req as SessionAuthRequest).user ?? null)) {
            res.status(403).json({ error: 'Video not available' });
            return;
        }

        const { page, limit, skip } = parseRequestPagination(req.query, {
            defaultLimit: DEFAULT_PAGE_LIMIT,
            maxLimit: MAX_PAGE_LIMIT,
        });

        const [rows, total] = await Promise.all([
            prisma.comment.findMany({
                where: { videoId: video.id, parentId: null },
                select: commentListSelect,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.comment.count({ where: { videoId: video.id, parentId: null } }),
        ]);

        const requesterId = getOptionalUserId(req);
        const likedIds = await getLikedCommentIds(
            requesterId,
            rows.map((comment) => comment.id),
        );

        res.json({
            comments: mapCommentListItems(rows, requesterId, likedIds),
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
