import { Request, Response } from 'express';
import { uploadFile, BUCKETS, getFileUrl, minioClient } from '../lib/minio.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { Readable } from 'stream';
import {
  generateVideoId,
  addToProcessingQueue,
  VIDEO_QUALITIES,
} from '../lib/videoProcessor.js';
import { prisma } from '../lib/prisma.js';
import { videoOriginalPath, avatarPath, bannerPath } from '../lib/paths.js';
import { generateSecureFilename } from '../lib/fileUtils.js';

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_THUMBNAIL_MB = Math.round(MAX_THUMBNAIL_BYTES / (1024 * 1024));

const parseTags = (tags: unknown): string[] => {
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag).trim())
      .filter((tag) => tag.length > 0);
  }

  return [];
};

type ThumbnailValidationError = {
  status: number;
  message: string;
};

const isAnimatedGif = (buffer: Buffer): boolean => {
  if (buffer.length < 14) return false;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;

  let offset = 6;
  const packed = buffer[offset + 4];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = 3 * (1 << ((packed & 0x07) + 1));
  offset += 7;
  if (hasGct) {
    offset += gctSize;
  }

  let frames = 0;
  while (offset < buffer.length) {
    const blockId = buffer[offset];
    if (blockId === 0x2c) {
      if (offset + 9 >= buffer.length) break;
      const packedFields = buffer[offset + 9];
      frames += 1;
      if (frames > 1) return true;
      offset += 10;
      if ((packedFields & 0x80) !== 0) {
        const lctSize = 3 * (1 << ((packedFields & 0x07) + 1));
        offset += lctSize;
      }
      if (offset >= buffer.length) break;
      offset += 1; // LZW min code size
      while (offset < buffer.length) {
        const blockSize = buffer[offset];
        offset += 1;
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }

    if (blockId === 0x21) {
      if (offset + 1 >= buffer.length) break;
      offset += 2; // extension introducer + label
      while (offset < buffer.length) {
        const blockSize = buffer[offset];
        offset += 1;
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }

    if (blockId === 0x3b) {
      break;
    }

    break;
  }

  return false;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const isAnimatedPng = (buffer: Buffer): boolean => {
  if (buffer.length < PNG_SIGNATURE.length) return false;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return false;
  }

  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    offset += 12 + length;
    if (length < 0) break;
  }

  return false;
};

const isAnimatedWebp = (buffer: Buffer): boolean => {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return false;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (type === 'ANIM' || type === 'ANMF') return true;
    const paddedSize = size + (size % 2);
    offset += 8 + paddedSize;
    if (size < 0) break;
  }

  return false;
};

const validateThumbnailRules = (
  file: Express.Multer.File,
): ThumbnailValidationError | null => {
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return {
      status: 413,
      message: `Thumbnail is too large. Max size is ${MAX_THUMBNAIL_MB}MB.`,
    };
  }

  const buffer = file.buffer;
  if (isAnimatedGif(buffer) || isAnimatedPng(buffer) || isAnimatedWebp(buffer)) {
    return {
      status: 400,
      message: 'Animated thumbnails are not allowed.',
    };
  }

  return null;
};

export const uploadVideo = async (
  req: SessionAuthRequest,
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
        tags: parseTags(tags),
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

export const uploadVideoBundle = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const videoFile = files?.video?.[0];
    const thumbnailFile = files?.thumbnail?.[0];
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

    const videoStream = Readable.from(videoFile.buffer);
    const storagePath = await uploadFile(
      BUCKETS.VIDEOS,
      originalPath,
      videoStream,
      videoFile.size,
      {
        'Content-Type': videoFile.mimetype,
        'uploaded-by': userId,
      },
    );

    let thumbnailPath: string | null = null;
    if (thumbnailFile) {
      const validationError = validateThumbnailRules(thumbnailFile);
      if (validationError) {
        res.status(validationError.status).json({ error: validationError.message });
        return;
      }
      const secureFilename = generateSecureFilename(thumbnailFile.originalname);
      thumbnailPath = `thumbnails/${userId}/${videoId}/${secureFilename}`;
      const thumbnailStream = Readable.from(thumbnailFile.buffer);
      await uploadFile(
        BUCKETS.VIDEOS,
        thumbnailPath,
        thumbnailStream,
        thumbnailFile.size,
        {
          'Content-Type': thumbnailFile.mimetype,
          'uploaded-by': userId,
        },
      );
    }

    const video = await prisma.video.create({
      data: {
        id: videoId,
        userId,
        title,
        description: description || null,
        tags: parseTags(tags),
        thumbnail: thumbnailPath,
      },
    });

    addToProcessingQueue({
      videoId,
      userId,
      originalPath: storagePath,
      qualities: VIDEO_QUALITIES,
    });

    const thumbnailUrl = thumbnailPath
      ? await getFileUrl(BUCKETS.VIDEOS, thumbnailPath)
      : null;

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: {
        id: video.id,
        title: video.title,
        thumbnailUrl,
      },
    });
  } catch (error) {
    console.error('Video upload (bundle) error:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

export const uploadAvatar = async (
  req: SessionAuthRequest,
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
  req: SessionAuthRequest,
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
  req: SessionAuthRequest,
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
    const validationError = validateThumbnailRules(thumbnailFile);
    if (validationError) {
      res.status(validationError.status).json({ error: validationError.message });
      return;
    }

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
