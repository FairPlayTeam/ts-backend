import { Request, Response } from 'express';
import { startOfDay } from 'date-fns';
import { prisma } from '../lib/prisma.js';
import { BUCKETS, minioClient } from '../lib/minio.js';
import { hlsVariantIndex } from '../lib/paths.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import {
  buildPublicUrl,
  getProxiedAssetUrl,
  getProxiedThumbnailUrl,
} from '../lib/utils.js';
import { canAccessVideo, canBuildPlaybackUrls } from '../lib/videoAccess.js';
import { createPlaybackToken } from '../lib/playbackTokens.js';
import {
  mapMyVideoItem,
  mapPublicVideoSummary,
  mapVideoDetails,
  type VideoHlsResponse,
} from '../lib/videoResponses.js';
import { parsePagination } from '../lib/pagination.js';
import { getPublicVideoId, resolveVideoByIdentifier } from '../lib/videoIds.js';
import { syncUserVideoStats } from '../lib/userVideoStats.js';

const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;

const buildPlaybackUrl = (
  pathname: string,
  playbackToken: string,
): string => {
  const url = new URL(buildPublicUrl(pathname));
  url.searchParams.set('token', playbackToken);
  return url.toString();
};

const incrementVideoView = async (
  videoId: string,
  videoUserId: string,
  requesterId: string,
): Promise<void> => {
  if (!requesterId) return;

  const today = startOfDay(new Date());

  try {
    let justCreated = false;

    try {
      await prisma.videoView.create({
        data: { userId: requesterId, videoId, date: today },
      });
      justCreated = true;
    } catch (error: any) {
      if (error?.code === 'P2002') return;
      throw error;
    }

    if (!justCreated) return;

    await prisma.$transaction([
      prisma.video.update({
        where: { id: videoId },
        data: { viewCount: { increment: 1n } },
      }),
      prisma.user.update({
        where: { id: videoUserId },
        data: { totalViews: { increment: 1n } },
      }),
    ]);
  } catch (error) {
    console.error('Error incrementing video view:', error);
  }
};

const PUBLIC_VIDEO_FILTER = {
  processingStatus: 'done',
  moderationStatus: 'approved',
  visibility: 'public',
  user: { isBanned: false },
} as const;

const PUBLIC_CREATOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  followerCount: true,
  videoCount: true,
  createdAt: true,
} as const;

const mixSearchResults = <
  TVideo extends Record<string, unknown>,
  TCreator extends Record<string, unknown>,
>(
  videos: TVideo[],
  creators: TCreator[],
) => {
  const results: Array<
    | { type: 'video'; video: TVideo }
    | { type: 'creator'; creator: TCreator }
  > = [];

  const maxLength = Math.max(videos.length, creators.length);
  for (let i = 0; i < maxLength; i += 1) {
    if (videos[i]) {
      results.push({ type: 'video', video: videos[i] });
    }

    if (creators[i]) {
      results.push({ type: 'creator', creator: creators[i] });
    }
  }

  return results;
};

export const getVideos = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: DEFAULT_PAGE_LIMIT,
      maxLimit: MAX_PAGE_LIMIT,
    });

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        where: PUBLIC_VIDEO_FILTER,
        select: {
          id: true,
          publicId: true,
          userId: true,
          title: true,
          description: true,
          thumbnail: true,
          viewCount: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
          ratings: { select: { score: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.video.count({ where: PUBLIC_VIDEO_FILTER }),
    ]);

    const videosWithUrls = videos.map(mapPublicVideoSummary);

    res.json({
      videos: videosWithUrls,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        itemsReturned: videosWithUrls.length,
      },
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
};

export const getTopViewedVideos = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const videos = await prisma.video.findMany({
      where: PUBLIC_VIDEO_FILTER,
      select: {
        id: true,
        publicId: true,
        userId: true,
        title: true,
        description: true,
        thumbnail: true,
        viewCount: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        ratings: { select: { score: true } },
      },
      orderBy: { viewCount: 'desc' },
      take: 3,
    });

    const videosWithUrls = videos.map(mapPublicVideoSummary);

    res.json({ videos: videosWithUrls });
  } catch (error) {
    console.error('Error fetching top viewed videos:', error);
    res.status(500).json({ error: 'Failed to fetch top viewed videos' });
  }
};

export const searchVideos = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { q = '' } = req.query;
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: DEFAULT_PAGE_LIMIT,
      maxLimit: MAX_PAGE_LIMIT,
    });

    const searchTerm = String(q).trim();

    const where: any = { ...PUBLIC_VIDEO_FILTER };
    if (searchTerm.length > 0) {
      where.OR = [
        { title: { contains: searchTerm, mode: 'insensitive' } },
        { tags: { has: searchTerm } },
        { user: { username: { contains: searchTerm, mode: 'insensitive' } } },
        {
          user: {
            displayName: { contains: searchTerm, mode: 'insensitive' },
          },
        },
      ];
    }

    const creatorWhere: any = {
      isBanned: false,
      videos: { some: PUBLIC_VIDEO_FILTER },
    };
    if (searchTerm.length > 0) {
      creatorWhere.OR = [
        { username: { contains: searchTerm, mode: 'insensitive' } },
        { displayName: { contains: searchTerm, mode: 'insensitive' } },
      ];
    }

    const [rows, total, creators, creatorsTotal] = await Promise.all([
      prisma.video.findMany({
        where,
        select: {
          id: true,
          publicId: true,
          userId: true,
          title: true,
          description: true,
          thumbnail: true,
          viewCount: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
          ratings: { select: { score: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.video.count({ where }),
      prisma.user.findMany({
        where: creatorWhere,
        select: PUBLIC_CREATOR_SELECT,
        orderBy: [{ followerCount: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.user.count({ where: creatorWhere }),
    ]);

    const videos = rows.map(mapPublicVideoSummary);

    const users = creators.map((creator) => ({
      ...creator,
      avatarUrl: getProxiedAssetUrl(creator.id, creator.avatarUrl),
    }));

    const results = mixSearchResults(videos, users);

    res.json({
      results,
      videos,
      creators: users,
      pagination: {
        videos: {
          page,
          limit,
          totalItems: total,
          totalPages: Math.ceil(total / limit),
          itemsReturned: videos.length,
        },
        creators: {
          page,
          limit,
          totalItems: creatorsTotal,
          totalPages: Math.ceil(creatorsTotal / limit),
          itemsReturned: users.length,
        },
        results: {
          page,
          limit: limit * 2,
          totalItems: total + creatorsTotal,
          totalPages: Math.ceil((total + creatorsTotal) / (limit * 2)),
          itemsReturned: results.length,
        },
      },
      query: { q: searchTerm },
    });
  } catch (error) {
    console.error('Error searching videos:', error);
    res.status(500).json({ error: 'Failed to search videos and creators' });
  }
};

export const getVideoById = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;

    const video = await resolveVideoByIdentifier(id, {
      id: true,
      publicId: true,
      userId: true,
      title: true,
      description: true,
      thumbnail: true,
      duration: true,
      tags: true,
      viewCount: true,
      allowComments: true,
      license: true,
      processingStatus: true,
      moderationStatus: true,
      visibility: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          isBanned: true,
        },
      },
      ratings: { select: { score: true, userId: true } },
    });

    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const requesterId: string | null = req.user?.id ?? null;
    const requesterRole: string | null = req.user?.role ?? null;
    const requester = {
      id: requesterId,
      role: requesterRole,
    };

    if (!canAccessVideo(video, requester)) {
      res.status(403).json({ error: 'Video not available' });
      return;
    }

    if (requesterId) {
      await incrementVideoView(video.id, video.userId, requesterId);
    }

    let hls: VideoHlsResponse = null;

    if (canBuildPlaybackUrls(video, requester)) {
      const playbackToken = createPlaybackToken({
        kind: 'playback',
        videoId: video.id,
        userId: video.userId,
      });
      const candidateQualities = ['1080p', '720p', '480p', '240p'];

      const statResults = await Promise.allSettled(
        candidateQualities.map((quality) =>
          minioClient.statObject(
            BUCKETS.VIDEOS,
            hlsVariantIndex(video.userId, video.id, quality),
          ),
        ),
      );

      const available = candidateQualities.filter(
        (_quality, index) => statResults[index].status === 'fulfilled',
      );

      const variants: Record<string, string | null> = {};
      for (const quality of candidateQualities) {
        variants[quality] = available.includes(quality)
          ? buildPlaybackUrl(
              `/stream/videos/${video.userId}/${video.id}/${quality}/index.m3u8`,
              playbackToken,
            )
          : null;
      }

      hls = {
        master: buildPlaybackUrl(
          `/stream/videos/${video.userId}/${video.id}/master.m3u8`,
          playbackToken,
        ),
        variants,
        available,
        preferred: available[0] ?? null,
      };
    }

    const userRating = requesterId
      ? (video.ratings.find((rating) => rating.userId === requesterId)?.score ??
          null)
      : null;

    res.json(
      mapVideoDetails(
        {
          ...video,
          user: {
            ...video.user,
            avatarUrl: video.user.avatarUrl,
          },
        },
        {
          hls,
          userRating,
        },
      ),
    );
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
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: DEFAULT_PAGE_LIMIT,
      maxLimit: MAX_PAGE_LIMIT,
    });

    const [videos, total] = await Promise.all([
      prisma.video.findMany({
        where: { userId },
        select: {
          id: true,
          publicId: true,
          userId: true,
          title: true,
          description: true,
          thumbnail: true,
          viewCount: true,
          createdAt: true,
          visibility: true,
          processingStatus: true,
          moderationStatus: true,
          ratings: { select: { score: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.video.count({ where: { userId } }),
    ]);

    const videosWithUrls = videos.map(mapMyVideoItem);

    res.json({
      videos: videosWithUrls,
      pagination: {
        page,
        limit,
        totalItems: total,
        totalPages: Math.ceil(total / limit),
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
    const video = await resolveVideoByIdentifier(videoId, {
      id: true,
      userId: true,
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
      where: { id: video.id },
      data: { title, description, visibility },
      select: {
        id: true,
        publicId: true,
        userId: true,
        title: true,
        description: true,
        thumbnail: true,
        visibility: true,
        updatedAt: true,
      },
    });

    res.json({
      message: 'Video updated successfully',
      video: {
        id: getPublicVideoId(updatedVideo),
        userId: updatedVideo.userId,
        title: updatedVideo.title,
        description: updatedVideo.description,
        visibility: updatedVideo.visibility,
        updatedAt: updatedVideo.updatedAt,
        thumbnailUrl: getProxiedThumbnailUrl(
          updatedVideo.userId,
          updatedVideo.id,
          updatedVideo.thumbnail,
        ),
      },
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

    const video = await resolveVideoByIdentifier(id, {
      id: true,
      userId: true,
      thumbnail: true,
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

    await prisma.$transaction(async (tx) => {
      await tx.commentLike.deleteMany({
        where: { comment: { videoId: video.id } },
      });
      await tx.rating.deleteMany({ where: { videoId: video.id } });
      await tx.comment.deleteMany({ where: { videoId: video.id } });
      await tx.videoView.deleteMany({ where: { videoId: video.id } });
      await tx.video.delete({ where: { id: video.id } });
      await syncUserVideoStats(tx, video.userId);
    });

    await deleteVideoStorageObjects(video.userId, video.id, video.thumbnail);

    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
};

const listMinioObjects = async (
  bucket: string,
  prefix: string,
): Promise<string[]> => {
  const objectNames: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = minioClient.listObjectsV2(bucket, prefix, true);
    stream.on('data', (objectInfo) => {
      if (objectInfo.name) {
        objectNames.push(objectInfo.name);
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return objectNames;
};

const deleteMinioObjects = async (
  bucket: string,
  objectNames: string[],
): Promise<void> => {
  if (objectNames.length === 0) {
    return;
  }

  await minioClient.removeObjects(bucket, objectNames);
};

const deleteVideoStorageObjects = async (
  userId: string,
  videoId: string,
  thumbnailPath: string | null,
): Promise<void> => {
  try {
    const objectNames = await listMinioObjects(
      BUCKETS.VIDEOS,
      `${userId}/${videoId}/`,
    );

    if (thumbnailPath) {
      objectNames.push(thumbnailPath);
    }

    await deleteMinioObjects(BUCKETS.VIDEOS, Array.from(new Set(objectNames)));
  } catch (error) {
    console.error(
      `Video ${videoId} was removed from the database but storage cleanup failed:`,
      error,
    );
  }
};
