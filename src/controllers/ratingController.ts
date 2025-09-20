import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from '../lib/auth.js';

export const rateVideo = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { videoId } = req.params;
    const { score } = req.body;

    if (score < 1 || score > 5) {
      res.status(400).json({ error: 'Score must be between 1 and 5' });
      return;
    }

    const existingRating = await prisma.rating.findUnique({
      where: {
        userId_videoId: {
          userId,
          videoId,
        },
      },
    });

    if (existingRating) {
      const updatedRating = await prisma.rating.update({
        where: {
          userId_videoId: {
            userId,
            videoId,
          },
        },
        data: { score },
      });
      res.json({ message: 'Rating updated', rating: updatedRating });
    } else {
      const newRating = await prisma.rating.create({
        data: {
          userId,
          videoId,
          score,
        },
      });
      res.status(201).json({ message: 'Rating created', rating: newRating });
    }
  } catch (error: any) {
    if (error?.code === 'P2003') {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    console.error('Rate video error:', error);
    res.status(500).json({ error: 'Failed to rate video' });
  }
};
