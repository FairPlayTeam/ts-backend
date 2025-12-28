import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { BUCKETS, getFileUrl } from '../lib/minio.js';
import { hlsVariantIndex } from '../lib/paths.js';
import { minioClient } from '../lib/minio.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedThumbnailUrl } from '../lib/utils.js';
import type { Video, User, Rating } from '@prisma/client';
import { validate as isUUID } from 'uuid';
import { getProxiedAssetUrl } from '../lib/utils.js';
import { startOfDay } from 'date-fns';

const incrementVideoView = async (
  video: Video,
  userId: string | null,
): Promise<void> => {
  if (!userId) {
    return;
  }

  const today = startOfDay(new Date());

  try {
    const existing = await prisma.videoView.findUnique({
      where: {
        userId_videoId_date: {
          userId,
          videoId: video.id,
          date: today,
        },
      },
    });

    if (existing) {
      return;
    }

    await prisma.$transaction([
      prisma.videoView.create({
        data: {
          userId,
          videoId: video.id,
          date: today,
        },
      }),
      prisma.video.update({
        where: { id: video.id },
        data: {
          viewCount: {
            increment: 1n,
          },
        },
      }),
      prisma.user.update({
        where: { id: video.userId },
        data: {
          totalViews: {
            increment: 1n,
          },
        },
      }),
    ]);
  } catch (error) {
    console.error('Error incrementing video view:', error);
  }
};

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
        const thumbnailUrl = getProxiedThumbnailUrl(
          video.userId,
          video.id,
          video.thumbnail,
        );

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

    const total = await prisma.video.count({
      where: {
        processingStatus: 'done',
        moderationStatus: 'approved',
        visibility: 'public',
        user: { isBanned: false },
      },
    });

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: videosWithUrls.length,
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
        const thumbnailUrl = getProxiedThumbnailUrl(
          video.userId,
          video.id,
          video.thumbnail,
        );
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
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: results.length,
      },
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

    if (!isUUID(id)) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const video = await prisma.video.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
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
    let requesterRole: string | null = null;

    const authHeader = req.headers['authorization'];
    const sessionKey = authHeader && authHeader.split(' ')[1];

    if (sessionKey) {
      try {
        const { validateSession } = await import('./sessionController.js');
        const session = await validateSession(sessionKey);
        requesterId = session?.user?.id || null;
        requesterRole = session?.user?.role || null;
      } catch (_) {}
    }

    const isPubliclyPlayable =
      videoObj.processingStatus === 'done' &&
      videoObj.moderationStatus === 'approved' &&
      videoObj.visibility === 'public';

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

    const isOwner = requesterId === videoObj.userId;
    const isModerator =
      requesterRole === 'moderator' || requesterRole === 'admin';

    if (!isPubliclyPlayable && !isOwner && !isModerator) {
      res.status(403).json({ error: 'Video not available' });
      return;
    }

    await incrementVideoView(videoObj, requesterId);

    let hls: any = null;

    const canBuildHls =
      isPubliclyPlayable ||
      (isOwner && videoObj.processingStatus === 'done') ||
      (isModerator && videoObj.processingStatus === 'done');

    if (canBuildHls) {
      const protocol = req.get('X-Forwarded-Proto') || req.protocol;
      const base = `${protocol}://${req.get('host')}`;
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

    const thumbnailUrl = getProxiedThumbnailUrl(
      videoObj.userId,
      videoObj.id,
      videoObj.thumbnail,
    );

    const avatarAssetUrl = getProxiedAssetUrl(
      videoObj.user.id,
      videoObj.user.avatarUrl,
      'avatar',
    );

    const ratings2 = videoObj.ratings || [];
    const avgRating =
      ratings2.length > 0
        ? ratings2.reduce((sum: number, r: Rating) => sum + r.score, 0) /
          ratings2.length
        : 0;

    res.json({
      ...videoObj,
      viewCount: videoObj.viewCount.toString(),
      hls,
      thumbnailUrl,
      avgRating: Math.round(avgRating * 10) / 10,
      ratingsCount: videoObj.ratings.length,
      user: {
        ...videoObj.user,
        avatarUrl: avatarAssetUrl,
      },
    });
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).json({ error: 'Failed to fetch video' });
  }
};

export const getUserVideos = async (
  req: SessionAuthRequest,
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
        const thumbnailUrl = getProxiedThumbnailUrl(
          video.userId,
          video.id,
          video.thumbnail,
        );

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

    const total = await prisma.video.count({ where: { userId } });

    res.json({
      videos: videosWithUrls,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / Number(limit)),
        itemsReturned: videosWithUrls.length,
      },
    });
  } catch (error) {
    console.error('Error fetching user videos:', error);
    res.status(500).json({ error: 'Failed to fetch user videos' });
  }
};

export const updateVideo = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user!.id;
  const { id: videoId } = req.params;
  const { title, description, visibility } = req.body;

  try {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    if (video.userId !== userId) {
      res
        .status(403)
        .json({ error: 'You are not authorized to edit this video' });
      return;
    }

    const updatedVideo = await prisma.video.update({
      where: { id: videoId },
      data: {
        title,
        description,
        visibility,
      },
    });

    const thumbnailUrl = getProxiedThumbnailUrl(
      updatedVideo.userId,
      updatedVideo.id,
      updatedVideo.thumbnail,
    );

    res.json({
      message: 'Video updated successfully',
      video: { ...updatedVideo, thumbnailUrl },
    });
  } catch (error) {
    console.error('Update video error:', error);
    res.status(500).json({ error: 'Failed to update video' });
  }
};

export const deleteVideo = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const requester = req.user;

    if (!requester) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!isUUID(id)) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const video = await prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        thumbnail: true,
      },
    });

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const isOwner = requester.id === video.userId;
    const isModerator =
      requester.role === 'admin' || requester.role === 'moderator';

    if (!isOwner && !isModerator) {
      res
        .status(403)
        .json({ error: 'You are not authorized to delete this video' });
      return;
    }

    // HLS cleanup
    const qualities = ['1080p', '720p', '480p', '240p', 'master'];
    for (const q of qualities) {
      try {
        await minioClient.removeObject(
          BUCKETS.VIDEOS,
          hlsVariantIndex(video.userId, video.id, q),
        );
      } catch (_) {}
    }

    // delete thumbnails
    if (video.thumbnail) {
      try {
        await minioClient.removeObject(
          BUCKETS.USERS,
          `${video.userId}/videos/${video.id}/thumbnail/${video.thumbnail}`,
        );
      } catch (_) {}
    }

    // postgres cleanup
    await prisma.$transaction([
      prisma.rating.deleteMany({
        where: { videoId: video.id },
      }),
      prisma.comment.deleteMany({
        where: { videoId: video.id },
      }),
      prisma.video.delete({
        where: { id: video.id },
      }),
    ]);

    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
};