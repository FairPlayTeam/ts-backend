import { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { canAccessVideo } from '../lib/videoAccess.js';
import { resolveVideoByIdentifier } from '../lib/videoIds.js';

const videoAccessSelect = {
    id: true,
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

export const rateVideo = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { videoId } = req.params;
        const { score } = req.body;

        if (!Number.isInteger(score) || score < 1 || score > 5) {
            res.status(400).json({ error: 'Score must be an integer between 1 and 5' });
            return;
        }

        const video = await resolveVideoByIdentifier(videoId, videoAccessSelect);
        if (!video) {
            res.status(404).json({ error: 'Video not found' });
            return;
        }

        if (!canAccessVideo(video, req.user)) {
            res.status(403).json({ error: 'Video not available' });
            return;
        }

        const [rating, stats] = await prisma.$transaction([
            prisma.rating.upsert({
                where: { userId_videoId: { userId, videoId: video.id } },
                update: { score },
                create: { userId, videoId: video.id, score },
            }),
            prisma.rating.aggregate({
                where: { videoId: video.id },
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
