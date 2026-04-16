import { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { isUUID } from '../lib/utils.js';
import { canAccessVideo } from '../lib/videoAccess.js';

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

export const likeComment = async (
	req: SessionAuthRequest,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user!.id;
		const { commentId } = req.params;

		if (!isUUID(commentId)) {
			res.status(400).json({ error: 'Invalid comment ID format' });
			return;
		}

		const comment = await prisma.comment.findUnique({
			where: { id: commentId },
			select: {
				id: true,
				isDeleted: true,
				video: {
					select: videoAccessSelect,
				},
			},
		});
		if (!comment || comment.isDeleted) {
			res.status(404).json({ error: 'Comment not found' });
			return;
		}

		if (!canAccessVideo(comment.video, req.user)) {
			res.status(403).json({ error: 'Video not available' });
			return;
		}

		const [, updated] = await prisma.$transaction([
			prisma.commentLike.create({
				data: { userId, commentId },
			}),
			prisma.comment.update({
				where: { id: commentId },
				data: { likeCount: { increment: 1 } },
			}),
		]);

		res.status(201).json({ message: 'Comment liked', likeCount: updated.likeCount });
	} catch (error: any) {
		if (error?.code === 'P2002') {
			res.status(409).json({ error: 'Comment already liked' });
			return;
		}
		if (error?.code === 'P2025') {
			res.status(404).json({ error: 'Comment not found' });
			return;
		}
		console.error('Like comment error:', error);
		res.status(500).json({ error: 'Failed to like comment' });
	}
};

export const unlikeComment = async (
	req: SessionAuthRequest,
	res: Response,
): Promise<void> => {
	try {
		const userId = req.user!.id;
		const { commentId } = req.params;

		if (!isUUID(commentId)) {
			res.status(400).json({ error: 'Invalid comment ID format' });
			return;
		}

		const comment = await prisma.comment.findUnique({
			where: { id: commentId },
			select: {
				id: true,
				isDeleted: true,
				video: {
					select: videoAccessSelect,
				},
			},
		});

		if (!comment || comment.isDeleted) {
			res.status(404).json({ error: 'Comment not found' });
			return;
		}

		if (!canAccessVideo(comment.video, req.user)) {
			res.status(403).json({ error: 'Video not available' });
			return;
		}

		const [, updated] = await prisma.$transaction([
			prisma.commentLike.delete({
				where: { userId_commentId: { userId, commentId } },
			}),
			prisma.comment.updateMany({
				where: { id: commentId },
				data: { likeCount: { decrement: 1 } },
			}),
		]);

		const refreshedComment = await prisma.comment.findUnique({
			where: { id: commentId },
			select: { likeCount: true },
		});

		res.status(200).json({ message: 'Comment unliked', likeCount: refreshedComment?.likeCount ?? 0 });
	} catch (error: any) {
		if (error?.code === 'P2025') {
			res.status(404).json({ error: 'You have not liked this comment' });
			return;
		}
		console.error('Unlike comment error:', error);
		res.status(500).json({ error: 'Failed to unlike comment' });
	}
};
