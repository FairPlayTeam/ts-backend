import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { AuthRequest } from '../lib/auth.js';
import { getFileUrl, BUCKETS, minioClient } from '../lib/minio.js';
import { hlsVariantIndex } from '../lib/paths.js';
import type { Video, User, Rating } from '@prisma/client';

export const getVideos = async (req: Request, res: Response): Promise<void> => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const videos = await prisma.video.findMany({
      where: {
        processingStatus: 'done',
        moderationStatus: 'approved',
        visibility: 'public',
        user: { isBanned: false },
      },
      include: {
        user: {
          select: {
            username: true,
            displayName: true,
          },
        },
        ratings: {
          select: {
            score: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    });

    const videosWithUrls = await Promise.all(
      videos.map(async (video: any) => {
        const thumbnailUrl = video.thumbnail
          ? await getFileUrl(BUCKETS.VIDEOS, video.thumbnail)
          : null;

        const avgRating =
          video.ratings.length > 0
            ? video.ratings.reduce((sum: number, r: any) => sum + r.score, 0) /
              video.ratings.length
            : 0;

        return {
          ...video,
          thumbnailUrl,
          viewCount: video.viewCount.toString(),
          avgRating: Math.round(avgRating * 10) / 10,
          ratingsCount: video.ratings.length,
        };
      }),
    );

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: await prisma.video.count({
          where: {
            processingStatus: 'done',
            moderationStatus: 'approved',
            visibility: 'public',
            user: { isBanned: false },
          },
        }),
      },
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
};

export const searchVideos = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { q = '', page = '1', limit = '20' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {
      processingStatus: 'done',
      moderationStatus: 'approved',
      visibility: 'public',
      user: { isBanned: false },
    };
    if (q && String(q).trim().length > 0) {
      where.OR = [
        { title: { contains: String(q), mode: 'insensitive' } },
        { user: { username: { contains: String(q), mode: 'insensitive' } } },
        { user: { displayName: { contains: String(q), mode: 'insensitive' } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.video.findMany({
        where,
        include: {
          user: { select: { username: true, displayName: true } },
          ratings: { select: { score: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.video.count({ where }),
    ]);

    const results = await Promise.all(
      rows.map(async (video: any) => {
        const avgRating =
          video.ratings.length > 0
            ? video.ratings.reduce((sum: number, r: any) => sum + r.score, 0) /
              video.ratings.length
            : 0;
        const thumbnailUrl = video.thumbnail
          ? await getFileUrl(BUCKETS.VIDEOS, video.thumbnail).catch(() => null)
          : null;
        return {
          id: video.id,
          title: video.title,
          thumbnailUrl,
          viewCount: video.viewCount.toString(),
          avgRating: Math.round(avgRating * 10) / 10,
          ratingsCount: video.ratings.length,
          user: video.user,
          createdAt: video.createdAt,
        };
      }),
    );

    res.json({
      videos: results,
      pagination: { page: Number(page), limit: Number(limit), total },
      query: { q },
    });
  } catch (error) {
    console.error('Error searching videos:', error);
    res.status(500).json({ error: 'Failed to search videos' });
  }
};

export const getVideoById = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        user: {
          select: { username: true, displayName: true },
        },
        ratings: true,
      },
    });

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const videoObj = video;

    let requesterId: string | null = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      try {
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
        requesterId = decoded.userId || null;
      } catch (_) {}
    }

    const isPubliclyPlayable =
      videoObj.processingStatus === 'done' &&
      videoObj.moderationStatus === 'approved' &&
      videoObj.visibility === 'public';

    // block if owner is banned for public playback
    if (isPubliclyPlayable) {
      const owner = await prisma.user.findUnique({
        where: { id: videoObj.userId },
        select: { isBanned: true },
      });
      if (owner?.isBanned) {
        if (requesterId !== videoObj.userId) {
          res.status(403).json({ error: 'Video not available' });
          return;
        }
      }
    }

    if (!isPubliclyPlayable && requesterId !== videoObj.userId) {
      res.status(403).json({ error: 'Video not available' });
      return;
    }

    let hls: any = null;
    if (isPubliclyPlayable) {
      const base = `${req.protocol}://${req.get('host')}`;
      const masterUrl = `${base}/stream/videos/${videoObj.userId}/${videoObj.id}/master.m3u8`;

      const candidateQualities = ['1080p', '720p', '480p', '240p'];
      const available: string[] = [];
      for (const q of candidateQualities) {
        try {
          await minioClient.statObject(
            BUCKETS.VIDEOS,
            hlsVariantIndex(videoObj.userId, videoObj.id, q),
          );
          available.push(q);
        } catch (_) {}
      }

      const variantUrls: Record<string, string | null> = {};
      for (const q of candidateQualities) {
        variantUrls[q] = available.includes(q)
          ? `${base}/stream/videos/${videoObj.userId}/${videoObj.id}/${q}/index.m3u8`
          : null;
      }
      hls = {
        master: masterUrl,
        variants: variantUrls,
        available,
        preferred: available[0] || null,
      };
    }

    const thumbnailUrl = videoObj.thumbnail
      ? await getFileUrl(BUCKETS.VIDEOS, videoObj.thumbnail).catch(() => null)
      : null;

    const ratings2 = videoObj.ratings || [];
    const avgRating =
      ratings2.length > 0
        ? ratings2.reduce((sum: number, r: any) => sum + r.score, 0) /
          ratings2.length
        : 0;

    res.json({
      ...videoObj,
      viewCount: videoObj.viewCount.toString(),
      hls,
      thumbnailUrl,
      avgRating: Math.round(avgRating * 10) / 10,
      ratingsCount: videoObj.ratings.length,
    });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
};

export const getUserVideos = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const videos = await prisma.video.findMany({
      where: { userId },
      include: {
        ratings: {
          select: {
            score: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: Number(limit),
    });

    const videosWithUrls = await Promise.all(
      videos.map(async (video) => {
        const thumbnailUrl = video.thumbnail
          ? await getFileUrl(BUCKETS.VIDEOS, video.thumbnail).catch(() => null)
          : null;

        const avgRating =
          video.ratings.length > 0
            ? video.ratings.reduce((sum: number, r: any) => sum + r.score, 0) /
              video.ratings.length
            : 0;

        return {
          ...video,
          thumbnailUrl,
          viewCount: video.viewCount.toString(),
          avgRating: Math.round(avgRating * 10) / 10,
          ratingsCount: video.ratings.length,
        };
      }),
    );

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: await prisma.video.count({ where: { userId } }),
      },
    });
  } catch (error) {
    console.error('Error fetching user videos:', error);
    res.status(500).json({ error: 'Failed to fetch user videos' });
  }
};
