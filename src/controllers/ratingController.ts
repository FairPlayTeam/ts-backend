import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { isUUID } from '../lib/utils.js';

export const rateVideo = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId } = req.params;
        const { score } = req.body;

        if (!isUUID(videoId)) {
            res.status(400).json({ error: 'Invalid video ID format' });
            return;
        }

        if (!Number.isInteger(score) || score < 1 || score > 5) {
            res.status(400).json({ error: 'Score must be an integer between 1 and 5' });
            return;
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { id: true },
        });
        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        const [rating, stats] = await prisma.$transaction([
            prisma.rating.upsert({
                where: { userId_videoId: { userId, videoId } },
                update: { score },
                create: { userId, videoId, score },
            }),
            prisma.rating.aggregate({
                where: { videoId },
                _avg: { score: true },
                _count: { score: true },
            }),
        ]);

        res.status(200).json({
            message: 'Rating saved',
            userScore: rating.score,
            averageScore: stats._avg.score
                ? Math.round(stats._avg.score * 10) / 10
                : null,
            totalRatings: stats._count.score,
        });
    } catch (error: any) {
        if (error?.code === 'P2003') {
            res.status(404).json({ error: 'Video not found' });
            return;
        }
        console.error('Rate video error:', error);
        res.status(500).json({ error: 'Failed to rate video' });
    }
};

export const getVideoRating = async (
    req: Request,
    res: Response,
): Promise<void> => {
    try {
        const { videoId } = req.params;
        const requesterId = (req as SessionAuthRequest).user?.id;

        if (!isUUID(videoId)) {
            res.status(400).json({ error: 'Invalid video ID format' });
            return;
        }

        const video = await prisma.video.findUnique({
            where: { id: videoId },
            select: { id: true },
        });
        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        const [stats, userRating] = await Promise.all([
            prisma.rating.aggregate({
                where: { videoId },
                _avg: { score: true },
                _count: { score: true },
            }),
            requesterId
                ? prisma.rating.findUnique({
                      where: { userId_videoId: { userId: requesterId, videoId } },
                      select: { score: true },
                  })
                : Promise.resolve(null),
        ]);

        res.json({
            averageScore: stats._avg.score
                ? Math.round(stats._avg.score * 10) / 10
                : null,
            totalRatings: stats._count.score,
            userScore: userRating?.score ?? null,
        });
    } catch (error) {
        console.error('Get video rating error:', error);
        res.status(500).json({ error: 'Failed to get video rating' });
    }
};