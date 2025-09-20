import { Request, Response } from 'express';
import { uploadFile, BUCKETS, getFileUrl } from '../lib/minio.js';
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

    res.json({
      message: 'Avatar uploaded successfully',
      storagePath,
      size: avatarFile.size,
      mimetype: avatarFile.mimetype,
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

    res.json({
      message: 'Banner uploaded successfully',
      storagePath,
      size: bannerFile.size,
      mimetype: bannerFile.mimetype,
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
