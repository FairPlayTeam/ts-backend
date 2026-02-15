import { Request, Response } from 'express';
import crypto from 'node:crypto';
import { uploadFile, BUCKETS, getFileUrl, minioClient } from '../lib/minio.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileTypeFromFile } from 'file-type';
import {
  generateVideoId,
  addToProcessingQueue,
  VIDEO_QUALITIES,
} from '../lib/videoProcessor.js';
import { prisma } from '../lib/prisma.js';
import { videoOriginalPath, avatarPath, bannerPath } from '../lib/paths.js';
import { generateSecureFilename } from '../lib/fileUtils.js';
import { getProxiedThumbnailUrl } from '../lib/utils.js';

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_THUMBNAIL_MB = Math.round(MAX_THUMBNAIL_BYTES / (1024 * 1024));
// Cloudflare Tunnel caps request body around 100 MB. Keep margin for multipart overhead.
const VIDEO_CHUNK_BYTES = 95 * 1024 * 1024;
const VIDEO_CHUNK_MB = Math.round(VIDEO_CHUNK_BYTES / (1024 * 1024));
const VIDEO_CHUNK_UPLOAD_ROOT = path.join(tmpdir(), 'fpbackend-video-chunks');
const VIDEO_CHUNK_MANIFEST_FILE = 'manifest.json';
const VIDEO_CHUNK_ASSEMBLED_FILE = 'assembled-video.bin';
const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
];

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

type ChunkedVideoManifest = {
  uploadId: string;
  userId: string;
  title: string;
  description: string | null;
  tags: string[];
  totalSize: number;
  totalChunks: number;
  originalName: string;
  mimeType: string | null;
  createdAt: string;
};

const parsePositiveInteger = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
};

const parseNonNegativeInteger = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    return null;
  }
  return num;
};

const isSafeUploadId = (uploadId: string): boolean =>
  /^[a-f0-9-]{36}$/i.test(uploadId);

const chunkFileName = (chunkIndex: number): string =>
  `chunk-${chunkIndex}.part`;

const getChunkUploadDir = (userId: string, uploadId: string): string =>
  path.join(VIDEO_CHUNK_UPLOAD_ROOT, userId, uploadId);

const getChunkManifestPath = (uploadDir: string): string =>
  path.join(uploadDir, VIDEO_CHUNK_MANIFEST_FILE);

const getChunkPath = (uploadDir: string, chunkIndex: number): string =>
  path.join(uploadDir, chunkFileName(chunkIndex));

const getChunkAssembledPath = (uploadDir: string): string =>
  path.join(uploadDir, VIDEO_CHUNK_ASSEMBLED_FILE);

const readChunkManifest = async (
  uploadDir: string,
): Promise<ChunkedVideoManifest | null> => {
  try {
    const manifestRaw = await fs.readFile(getChunkManifestPath(uploadDir), 'utf8');
    return JSON.parse(manifestRaw) as ChunkedVideoManifest;
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : '';

    if (code === 'ENOENT') {
      return null;
    }

    throw error;
  }
};

const writeChunkManifest = async (
  uploadDir: string,
  manifest: ChunkedVideoManifest,
): Promise<void> => {
  await fs.writeFile(
    getChunkManifestPath(uploadDir),
    JSON.stringify(manifest),
    'utf8',
  );
};

const listUploadedChunkIndexes = async (uploadDir: string): Promise<number[]> => {
  const entries = await fs.readdir(uploadDir, { withFileTypes: true });
  const indexes = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^chunk-(\d+)\.part$/.exec(entry.name);
      if (!match) {
        return null;
      }
      return Number.parseInt(match[1], 10);
    })
    .filter((index): index is number => index !== null)
    .sort((a, b) => a - b);

  return indexes;
};

const listMissingChunkIndexes = (
  totalChunks: number,
  uploadedChunkIndexes: number[],
): number[] => {
  const uploadedSet = new Set(uploadedChunkIndexes);
  const missing: number[] = [];

  for (let i = 0; i < totalChunks; i += 1) {
    if (!uploadedSet.has(i)) {
      missing.push(i);
    }
  }

  return missing;
};

const expectedChunkSize = (
  manifest: ChunkedVideoManifest,
  chunkIndex: number,
): number => {
  if (chunkIndex === manifest.totalChunks - 1) {
    return manifest.totalSize - VIDEO_CHUNK_BYTES * (manifest.totalChunks - 1);
  }
  return VIDEO_CHUNK_BYTES;
};

const assembleChunks = async (
  uploadDir: string,
  totalChunks: number,
  assembledPath: string,
): Promise<void> => {
  await fs.rm(assembledPath, { force: true });

  const output = createWriteStream(assembledPath, { flags: 'w' });

  try {
    for (let i = 0; i < totalChunks; i += 1) {
      const source = getChunkPath(uploadDir, i);

      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(source);

        const onError = (error: unknown) => {
          input.destroy();
          reject(error);
        };

        input.once('error', onError);
        output.once('error', onError);

        input.once('end', () => {
          output.removeListener('error', onError);
          resolve();
        });

        input.pipe(output, { end: false });
      });
    }

    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
};

const cleanupChunkUpload = async (uploadDir: string): Promise<void> => {
  try {
    await fs.rm(uploadDir, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed to cleanup chunk upload directory: ${uploadDir}`, error);
  }
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

const validateThumbnailRules = async (
  file: Express.Multer.File,
): Promise<ThumbnailValidationError | null> => {
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return {
      status: 413,
      message: `Thumbnail is too large. Max size is ${MAX_THUMBNAIL_MB}MB.`,
    };
  }

  const buffer = file.buffer ?? (file.path ? await fs.readFile(file.path) : null);
  if (!buffer) {
    return {
      status: 400,
      message: 'Invalid thumbnail payload.',
    };
  }
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

    const stream = createReadStream(videoFile.path);

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

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          userId,
          title,
          description: description || null,
          tags: parseTags(tags),
        },
      });

      const videoCount = await tx.video.count({
        where: { userId },
      });

      await tx.user.update({
        where: { id: userId },
        data: { videoCount },
      });

      return created;
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

    const videoStream = createReadStream(videoFile.path);
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
      const validationError = await validateThumbnailRules(thumbnailFile);
      if (validationError) {
        res.status(validationError.status).json({ error: validationError.message });
        return;
      }
      const secureFilename = generateSecureFilename(thumbnailFile.originalname);
      thumbnailPath = `thumbnails/${userId}/${videoId}/${secureFilename}`;
      const thumbnailStream = createReadStream(thumbnailFile.path);
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

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          userId,
          title,
          description: description || null,
          tags: parseTags(tags),
          thumbnail: thumbnailPath,
        },
      });

      const videoCount = await tx.video.count({
        where: { userId },
      });

      await tx.user.update({
        where: { id: userId },
        data: { videoCount },
      });

      return created;
    });

    addToProcessingQueue({
      videoId,
      userId,
      originalPath: storagePath,
      qualities: VIDEO_QUALITIES,
    });

    const thumbnailUrl = getProxiedThumbnailUrl(userId, videoId, thumbnailPath);

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

export const initChunkedVideoUpload = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const description =
      typeof req.body.description === 'string' && req.body.description.length > 0
        ? req.body.description
        : null;
    const tags = parseTags(req.body.tags);
    const totalSize = parsePositiveInteger(req.body.totalSize);
    const totalChunks = parsePositiveInteger(req.body.totalChunks);
    const originalName =
      typeof req.body.originalName === 'string' ? req.body.originalName : 'video';
    const mimeType =
      typeof req.body.mimeType === 'string' && req.body.mimeType.length > 0
        ? req.body.mimeType
        : null;

    if (!title) {
      res.status(400).json({ error: 'Video title is required' });
      return;
    }

    if (!totalSize || !totalChunks) {
      res.status(400).json({
        error: 'totalSize and totalChunks are required positive integers',
      });
      return;
    }

    const expectedLastChunkBytes =
      totalSize - VIDEO_CHUNK_BYTES * (totalChunks - 1);

    if (
      expectedLastChunkBytes <= 0 ||
      expectedLastChunkBytes > VIDEO_CHUNK_BYTES
    ) {
      res.status(400).json({
        error: `Invalid totalSize/totalChunks combination for ${VIDEO_CHUNK_MB}MB chunks`,
      });
      return;
    }

    const uploadId = crypto.randomUUID();
    const uploadDir = getChunkUploadDir(userId, uploadId);

    await fs.mkdir(uploadDir, { recursive: true });

    const manifest: ChunkedVideoManifest = {
      uploadId,
      userId,
      title,
      description,
      tags,
      totalSize,
      totalChunks,
      originalName,
      mimeType,
      createdAt: new Date().toISOString(),
    };

    await writeChunkManifest(uploadDir, manifest);

    res.status(201).json({
      uploadId,
      chunkSizeBytes: VIDEO_CHUNK_BYTES,
      chunkSizeMB: VIDEO_CHUNK_MB,
      totalChunks,
      totalSize,
    });
  } catch (error) {
    console.error('Chunked video upload init error:', error);
    res.status(500).json({ error: 'Failed to initialize chunked upload' });
  }
};

export const uploadVideoChunk = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { uploadId } = req.params;
    const chunkFile = req.file;
    const chunkIndex = parseNonNegativeInteger(req.body.chunkIndex);

    if (!uploadId || !isSafeUploadId(uploadId)) {
      res.status(400).json({ error: 'Invalid uploadId' });
      return;
    }

    if (!chunkFile) {
      res.status(400).json({ error: 'No chunk file provided' });
      return;
    }

    if (chunkIndex === null) {
      res.status(400).json({ error: 'chunkIndex must be a non-negative integer' });
      return;
    }

    if (chunkFile.size > VIDEO_CHUNK_BYTES) {
      res.status(413).json({
        error: `Chunk is too large. Max size is ${VIDEO_CHUNK_MB}MB.`,
      });
      return;
    }

    const uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) {
      res.status(404).json({ error: 'Chunk upload session not found' });
      return;
    }

    if (manifest.userId !== userId) {
      res.status(403).json({ error: 'You are not authorized for this upload' });
      return;
    }

    if (chunkIndex >= manifest.totalChunks) {
      res.status(400).json({
        error: `chunkIndex must be between 0 and ${manifest.totalChunks - 1}`,
      });
      return;
    }

    const expectedBytes = expectedChunkSize(manifest, chunkIndex);
    if (chunkFile.size !== expectedBytes) {
      res.status(400).json({
        error: `Invalid chunk size for index ${chunkIndex}. Expected ${expectedBytes} bytes.`,
      });
      return;
    }

    const finalChunkPath = getChunkPath(uploadDir, chunkIndex);
    await fs.rm(finalChunkPath, { force: true });
    await fs.rename(chunkFile.path, finalChunkPath);

    const uploadedChunkIndexes = await listUploadedChunkIndexes(uploadDir);
    const missingChunkIndexes = listMissingChunkIndexes(
      manifest.totalChunks,
      uploadedChunkIndexes,
    );

    res.json({
      message: 'Chunk uploaded successfully',
      uploadId,
      chunkIndex,
      receivedChunks: uploadedChunkIndexes.length,
      totalChunks: manifest.totalChunks,
      isComplete: missingChunkIndexes.length === 0,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
};

export const completeChunkedVideoUpload = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { uploadId } = req.params;

    if (!uploadId || !isSafeUploadId(uploadId)) {
      res.status(400).json({ error: 'Invalid uploadId' });
      return;
    }

    const uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) {
      res.status(404).json({ error: 'Chunk upload session not found' });
      return;
    }

    if (manifest.userId !== userId) {
      res.status(403).json({ error: 'You are not authorized for this upload' });
      return;
    }

    const uploadedChunkIndexes = await listUploadedChunkIndexes(uploadDir);
    const missingChunkIndexes = listMissingChunkIndexes(
      manifest.totalChunks,
      uploadedChunkIndexes,
    );

    if (missingChunkIndexes.length > 0) {
      res.status(400).json({
        error: 'Some chunks are missing',
        missingChunks: missingChunkIndexes,
      });
      return;
    }

    const assembledPath = getChunkAssembledPath(uploadDir);
    await assembleChunks(uploadDir, manifest.totalChunks, assembledPath);

    const assembledStat = await fs.stat(assembledPath);
    if (assembledStat.size !== manifest.totalSize) {
      res.status(400).json({
        error: `Assembled file size mismatch. Expected ${manifest.totalSize}, got ${assembledStat.size}.`,
      });
      return;
    }

    const detectedFileType = await fileTypeFromFile(assembledPath);
    if (
      !detectedFileType ||
      !ALLOWED_VIDEO_MIME_TYPES.includes(detectedFileType.mime)
    ) {
      res.status(400).json({
        error: 'Invalid file type. The assembled file is not a supported video.',
      });
      return;
    }

    const contentType =
      manifest.mimeType && ALLOWED_VIDEO_MIME_TYPES.includes(manifest.mimeType)
        ? manifest.mimeType
        : detectedFileType.mime;

    const videoId = generateVideoId();
    const originalPath = videoOriginalPath(userId, videoId);

    const stream = createReadStream(assembledPath);
    const storagePath = await uploadFile(
      BUCKETS.VIDEOS,
      originalPath,
      stream,
      assembledStat.size,
      {
        'Content-Type': contentType,
        'uploaded-by': userId,
      },
    );

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          userId,
          title: manifest.title,
          description: manifest.description,
          tags: manifest.tags,
        },
      });

      const videoCount = await tx.video.count({
        where: { userId },
      });

      await tx.user.update({
        where: { id: userId },
        data: { videoCount },
      });

      return created;
    });

    addToProcessingQueue({
      videoId,
      userId,
      originalPath: storagePath,
      qualities: VIDEO_QUALITIES,
    });

    await cleanupChunkUpload(uploadDir);

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: {
        id: video.id,
        title: video.title,
      },
    });
  } catch (error) {
    console.error('Chunked video upload completion error:', error);
    res.status(500).json({ error: 'Failed to finalize chunked upload' });
  }
};

export const abortChunkedVideoUpload = async (
  req: SessionAuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { uploadId } = req.params;

    if (!uploadId || !isSafeUploadId(uploadId)) {
      res.status(400).json({ error: 'Invalid uploadId' });
      return;
    }

    const uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) {
      res.status(404).json({ error: 'Chunk upload session not found' });
      return;
    }

    if (manifest.userId !== userId) {
      res.status(403).json({ error: 'You are not authorized for this upload' });
      return;
    }

    await cleanupChunkUpload(uploadDir);

    res.json({ message: 'Chunked upload aborted successfully' });
  } catch (error) {
    console.error('Chunked video upload abort error:', error);
    res.status(500).json({ error: 'Failed to abort chunked upload' });
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

    const stream = createReadStream(avatarFile.path);

    await uploadFile(
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

    const stream = createReadStream(bannerFile.path);

    await uploadFile(
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
    const validationError = await validateThumbnailRules(thumbnailFile);
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

    const stream = createReadStream(thumbnailFile.path);
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
