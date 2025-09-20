import { Request, Response } from 'express';
import { uploadFile, BUCKETS, getFileUrl, minioClient } from '../lib/minio.js';
import { AuthRequest } from '../lib/auth.js';
import { Readable } from 'stream';
import {
  generateVideoId,
  addToProcessingQueue,
  VIDEO_QUALITIES,
} from '../lib/videoProcessor.js';
import { prisma } from '../lib/prisma.js';
import { videoOriginalPath, avatarPath, bannerPath } from '../lib/paths.js';
import { generateSecureFilename } from '../lib/fileUtils.js';

export const uploadVideo = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const videoFile = req.file;
    const { title, description, tags } = req.body;

    if (!videoFile) {
      res.status(400).json({ error: 'No video file provided' });
      return;
    }

    if (!title) {
      res.status(400).json({ error: 'Video title is required' });
      return;
    }

    const userId = req.user!.id;
    const videoId = generateVideoId();
    const originalPath = videoOriginalPath(userId, videoId);

    const stream = Readable.from(videoFile.buffer);

    const storagePath = await uploadFile(
      BUCKETS.VIDEOS,
      originalPath,
      stream,
      videoFile.size,
      {
        'Content-Type': videoFile.mimetype,
        'uploaded-by': userId,
      },
    );

    const video = await prisma.video.create({
      data: {
        id: videoId,
        userId,
        title,
        description: description || null,
        tags:
          typeof tags === 'string'
            ? tags.split(',').map((t: string) => t.trim())
            : Array.isArray(tags)
            ? tags
            : [],
      },
    });

    addToProcessingQueue({
      videoId,
      userId,
      originalPath: storagePath,
      qualities: VIDEO_QUALITIES,
    });

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: {
        id: video.id,
        title: video.title,
      },
    });
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

export const uploadAvatar = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const avatarFile = req.file;

    if (!avatarFile) {
      res.status(400).json({ error: 'No avatar file provided' });
      return;
    }

    const userId = req.user!.id;
    const secureFilename = generateSecureFilename(avatarFile.originalname);
    const avatarObjectPath = avatarPath(userId, secureFilename);

    const stream = Readable.from(avatarFile.buffer);

    const storagePath = await uploadFile(
      BUCKETS.USERS,
      avatarObjectPath,
      stream,
      avatarFile.size,
      {
        'Content-Type': avatarFile.mimetype,
        'uploaded-by': userId,
      },
    );

    await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: avatarObjectPath },
    });

    res.json({
      message: 'Avatar uploaded successfully',
      avatarUrl: await getFileUrl(BUCKETS.USERS, avatarObjectPath),
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
};

export const uploadBanner = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const bannerFile = req.file;

    if (!bannerFile) {
      res.status(400).json({ error: 'No banner file provided' });
      return;
    }

    const userId = req.user!.id;
    const secureFilename = generateSecureFilename(bannerFile.originalname);
    const bannerObjectPath = bannerPath(userId, secureFilename);

    const stream = Readable.from(bannerFile.buffer);

    const storagePath = await uploadFile(
      BUCKETS.USERS,
      bannerObjectPath,
      stream,
      bannerFile.size,
      {
        'Content-Type': bannerFile.mimetype,
        'uploaded-by': userId,
      },
    );

    await prisma.user.update({
      where: { id: userId },
      data: { bannerUrl: bannerObjectPath },
    });

    res.json({
      message: 'Banner uploaded successfully',
      bannerUrl: await getFileUrl(BUCKETS.USERS, bannerObjectPath),
    });
  } catch (error) {
    console.error('Banner upload error:', error);
    res.status(500).json({ error: 'Failed to upload banner' });
  }
};

export const getFileDownloadUrl = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { bucket, filename } = req.params;
    const expiry = parseInt(req.query.expiry as string) || 24 * 60 * 60;

    if (!Object.values(BUCKETS).includes(bucket as any)) {
      res.status(400).json({ error: 'Invalid bucket name' });
      return;
    }

    const url = await getFileUrl(bucket, filename, expiry);

    res.json({
      url,
      expiresIn: expiry,
    });
  } catch (error) {
    console.error('Get file URL error:', error);
    res.status(500).json({ error: 'Failed to generate file URL' });
  }
};

export const updateThumbnail = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user!.id;
  const { id: videoId } = req.params;
  const thumbnailFile = req.file;

  if (!thumbnailFile) {
    res.status(400).json({ error: 'No thumbnail file provided' });
    return;
  }

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

    if (video.thumbnail) {
      try {
        await minioClient.removeObject(BUCKETS.VIDEOS, video.thumbnail);
      } catch (error) {
        console.error('Failed to delete old thumbnail:', error);
      }
    }

    const secureFilename = generateSecureFilename(thumbnailFile.originalname);
    const newThumbnailPath = `thumbnails/${userId}/${videoId}/${secureFilename}`;

    const stream = Readable.from(thumbnailFile.buffer);
    await uploadFile(
      BUCKETS.VIDEOS,
      newThumbnailPath,
      stream,
      thumbnailFile.size,
      {
        'Content-Type': thumbnailFile.mimetype,
        'uploaded-by': userId,
      },
    );

    const updatedVideo = await prisma.video.update({
      where: { id: videoId },
      data: { thumbnail: newThumbnailPath },
    });

    const thumbnailUrl = updatedVideo.thumbnail
      ? await getFileUrl(BUCKETS.VIDEOS, updatedVideo.thumbnail)
      : null;

    res.json({
      message: 'Thumbnail updated successfully',
      thumbnailUrl,
    });
  } catch (error) {
    console.error('Thumbnail update error:', error);
    res.status(500).json({ error: 'Failed to update thumbnail' });
  }
};
