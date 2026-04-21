import { Response } from 'express';
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
} from '../lib/videoProcessor.js';
import { prisma } from '../lib/prisma.js';
import { videoOriginalPath, avatarPath, bannerPath } from '../lib/paths.js';
import { generateSecureFilename } from '../lib/fileUtils.js';
import { getProxiedAssetUrl, getProxiedThumbnailUrl } from '../lib/utils.js';
import {
  normalizeStorageObjectName,
  parseStorageObjectTarget,
  type StorageBucketName,
} from '../lib/storageObjectAccess.js';
import {
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_MB,
  MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS,
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB,
  VIDEO_CHUNK_BYTES,
  VIDEO_CHUNK_MB,
  getRequiredVideoChunkCount,
  validateChunkedVideoUploadPlan,
} from '../lib/uploadConfig.js';
import { VIDEO_QUALITIES } from '../lib/videoProfiles.js';
import { isStaffRole } from '../lib/videoAccess.js';
import { APP_SLUG } from '../lib/appInfo.js';
import {
  generateUniqueVideoPublicId,
  getPublicVideoId,
  resolveVideoByIdentifier,
} from '../lib/videoIds.js';
import { syncUserVideoStats } from '../lib/userVideoStats.js';

const VIDEO_CHUNK_UPLOAD_ROOT = path.join(tmpdir(), `${APP_SLUG}-video-chunks`);
const VIDEO_CHUNK_MANIFEST_FILE = 'manifest.json';
const VIDEO_CHUNK_ASSEMBLED_FILE = 'assembled-video.bin';
const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
];

const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;
const CHUNK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const VALID_LICENSES = [
  'all_rights_reserved',
  'cc_by', 'cc_by_sa', 'cc_by_nd',
  'cc_by_nc', 'cc_by_nc_sa', 'cc_by_nc_nd',
  'cc0',
] as const;

type VideoLicense = typeof VALID_LICENSES[number];

const parseLicense = (value: unknown): VideoLicense => {
  if (typeof value === 'string' && VALID_LICENSES.includes(value as VideoLicense)) {
    return value as VideoLicense;
  }
  return 'all_rights_reserved';
};

const parseTags = (tags: unknown): string[] => {
  if (typeof tags === 'string') {
    return tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  }
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter((t) => t.length > 0);
  }
  return [];
};

const rollbackCreatedVideo = async (videoId: string, userId: string): Promise<void> => {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.video.delete({ where: { id: videoId } });
      await syncUserVideoStats(tx, userId);
    });
  } catch (error) {
    console.error(`Failed to rollback uploaded video ${videoId}:`, error);
  }
};

const removeUploadedObject = async (
  bucketName: string,
  objectName: string | null,
  context: string,
): Promise<void> => {
  if (!objectName) return;

  try {
    await minioClient.removeObject(bucketName, objectName);
  } catch (error) {
    console.error(`Failed to cleanup uploaded object for ${context}:`, error);
  }
};

type ChunkedVideoManifest = {
  uploadId: string;
  userId: string;
  title: string;
  description: string | null;
  tags: string[];
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  originalName: string;
  mimeType: string | null;
  createdAt: string;
  allowComments: boolean;
  license: VideoLicense;
};

const parsePositiveInteger = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
};

const parseNonNegativeInteger = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
};

const isSafeUploadId = (uploadId: string): boolean =>
  /^[a-f0-9-]{36}$/i.test(uploadId);

const chunkFileName = (chunkIndex: number): string => `chunk-${chunkIndex}.part`;
const getChunkUploadDir = (userId: string, uploadId: string): string =>
  path.join(VIDEO_CHUNK_UPLOAD_ROOT, userId, uploadId);
const getChunkManifestPath = (uploadDir: string): string =>
  path.join(uploadDir, VIDEO_CHUNK_MANIFEST_FILE);
const getChunkPath = (uploadDir: string, chunkIndex: number): string =>
  path.join(uploadDir, chunkFileName(chunkIndex));
const getChunkAssembledPath = (uploadDir: string): string =>
  path.join(uploadDir, VIDEO_CHUNK_ASSEMBLED_FILE);

const readChunkManifest = async (uploadDir: string): Promise<ChunkedVideoManifest | null> => {
  try {
    const raw = await fs.readFile(getChunkManifestPath(uploadDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ChunkedVideoManifest>;

    if (
      typeof parsed.uploadId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.title !== 'string' ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.totalSize !== 'number' ||
      typeof parsed.totalChunks !== 'number' ||
      typeof parsed.receivedChunks !== 'number' ||
      typeof parsed.originalName !== 'string' ||
      typeof parsed.createdAt !== 'string'
    ) {
      throw new Error('Invalid chunk upload manifest');
    }

    return {
      uploadId: parsed.uploadId,
      userId: parsed.userId,
      title: parsed.title,
      description: typeof parsed.description === 'string' ? parsed.description : null,
      tags: parsed.tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0),
      totalSize: parsed.totalSize,
      totalChunks: parsed.totalChunks,
      receivedChunks: parsed.receivedChunks,
      originalName: parsed.originalName,
      mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : null,
      createdAt: parsed.createdAt,
      allowComments: parsed.allowComments !== false,
      license: parseLicense(parsed.license),
    };
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
};

const writeChunkManifest = async (
  uploadDir: string,
  manifest: ChunkedVideoManifest,
): Promise<void> => {
  await fs.writeFile(getChunkManifestPath(uploadDir), JSON.stringify(manifest), 'utf8');
};

const listUploadedChunkIndexes = async (uploadDir: string): Promise<number[]> => {
  const entries = await fs.readdir(uploadDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const match = /^chunk-(\d+)\.part$/.exec(e.name);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((i): i is number => i !== null)
    .sort((a, b) => a - b);
};

const listMissingChunkIndexes = (totalChunks: number, uploaded: number[]): number[] => {
  const set = new Set(uploaded);
  return Array.from({ length: totalChunks }, (_, i) => i).filter((i) => !set.has(i));
};

const expectedChunkSize = (manifest: ChunkedVideoManifest, chunkIndex: number): number => {
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
    for (let i = 0; i < totalChunks; i++) {
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(getChunkPath(uploadDir, i));
        const onError = (err: unknown) => { input.destroy(); reject(err); };
        input.once('error', onError);
        output.once('error', onError);
        input.once('end', () => { output.removeListener('error', onError); resolve(); });
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

const cleanupAssembledChunkFile = async (uploadDir: string): Promise<void> => {
  try {
    await fs.rm(getChunkAssembledPath(uploadDir), { force: true });
  } catch (error) {
    console.error(
      `Failed to cleanup assembled chunk upload file in: ${uploadDir}`,
      error,
    );
  }
};

export const cleanupExpiredChunkSessions = async (): Promise<void> => {
  try {
    const userDirs = await fs.readdir(VIDEO_CHUNK_UPLOAD_ROOT, { withFileTypes: true });
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      const userPath = path.join(VIDEO_CHUNK_UPLOAD_ROOT, userDir.name);
      const sessionDirs = await fs.readdir(userPath, { withFileTypes: true });

      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        const sessionPath = path.join(userPath, sessionDir.name);
        const manifest = await readChunkManifest(sessionPath);
        if (!manifest) continue;

        const age = Date.now() - new Date(manifest.createdAt).getTime();
        if (age > CHUNK_SESSION_TTL_MS) {
          await cleanupChunkUpload(sessionPath);
        }
      }
    }
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : '';

    if (code === 'ENOENT') {
      return;
    }

    console.error('Failed to cleanup expired chunk sessions:', error);
  }
};

type ThumbnailValidationError = { status: number; message: string };

const isAnimatedGif = (buffer: Buffer): boolean => {
  if (buffer.length < 14) return false;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return false;
  let offset = 6;
  const packed = buffer[offset + 4];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = 3 * (1 << ((packed & 0x07) + 1));
  offset += 7;
  if (hasGct) offset += gctSize;
  let frames = 0;
  while (offset < buffer.length) {
    const blockId = buffer[offset];
    if (blockId === 0x2c) {
      if (offset + 9 >= buffer.length) break;
      const packedFields = buffer[offset + 9];
      frames++;
      if (frames > 1) return true;
      offset += 10;
      if ((packedFields & 0x80) !== 0) offset += 3 * (1 << ((packedFields & 0x07) + 1));
      if (offset >= buffer.length) break;
      offset++;
      while (offset < buffer.length) {
        const blockSize = buffer[offset++];
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }
    if (blockId === 0x21) {
      if (offset + 1 >= buffer.length) break;
      offset += 2;
      while (offset < buffer.length) {
        const blockSize = buffer[offset++];
        if (blockSize === 0) break;
        offset += blockSize;
      }
      continue;
    }
    break;
  }
  return false;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isAnimatedPng = (buffer: Buffer): boolean => {
  if (buffer.length < PNG_SIGNATURE.length) return false;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
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
    offset += 8 + (size + (size % 2));
    if (size < 0) break;
  }
  return false;
};

const ANIMATION_DETECT_BYTES = 4 * 1024;

const readFileHead = async (filePath: string): Promise<Buffer> => {
  const fd = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(ANIMATION_DETECT_BYTES);
    const { bytesRead } = await fd.read(buf, 0, ANIMATION_DETECT_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
};

const validateThumbnailRules = async (
  file: Express.Multer.File,
): Promise<ThumbnailValidationError | null> => {
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return { status: 413, message: `Thumbnail is too large. Max size is ${MAX_THUMBNAIL_MB}MB.` };
  }

  const buffer = file.buffer
    ? file.buffer.subarray(0, ANIMATION_DETECT_BYTES)
    : file.path
      ? await readFileHead(file.path)
      : null;

  if (!buffer) {
    return { status: 400, message: 'Invalid thumbnail payload.' };
  }

  if (isAnimatedGif(buffer) || isAnimatedPng(buffer) || isAnimatedWebp(buffer)) {
    return { status: 400, message: 'Animated thumbnails are not allowed.' };
  }

  return null;
};

export const uploadVideo = async (req: SessionAuthRequest, res: Response): Promise<void> => {
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
    const storagePath = `${BUCKETS.VIDEOS}/${originalPath}`;

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          publicId: await generateUniqueVideoPublicId(tx.video),
          userId,
          title,
          description: description || null,
          tags: parseTags(tags),
          storagePath,
        },
      });
      await syncUserVideoStats(tx, userId);
      return created;
    });

    try {
      const stream = createReadStream(videoFile.path);
      await uploadFile(BUCKETS.VIDEOS, originalPath, stream, videoFile.size, {
        'Content-Type': videoFile.mimetype,
        'uploaded-by': userId,
      });
    } catch (uploadError) {
      await rollbackCreatedVideo(videoId, userId);
      throw uploadError;
    }

    addToProcessingQueue({ videoId, userId, originalPath: storagePath, qualities: VIDEO_QUALITIES });

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: { id: getPublicVideoId(video), title: video.title },
    });
  } catch (error) {
    console.error('Video upload error:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

export const uploadVideoBundle = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const videoFile = files?.video?.[0];
    const thumbnailFile = files?.thumbnail?.[0];
    const { title, description, tags, allowComments: allowCommentsRaw } = req.body;
    const license = parseLicense(req.body.license);

    if (!videoFile) {
      res.status(400).json({ error: 'No video file provided' });
      return;
    }
    if (!title) {
      res.status(400).json({ error: 'Video title is required' });
      return;
    }

    if (thumbnailFile) {
      const validationError = await validateThumbnailRules(thumbnailFile);
      if (validationError) {
        res.status(validationError.status).json({ error: validationError.message });
        return;
      }
    }

    const userId = req.user!.id;
    const videoId = generateVideoId();
    const originalPath = videoOriginalPath(userId, videoId);
    const storagePath = `${BUCKETS.VIDEOS}/${originalPath}`;
    const allowComments = allowCommentsRaw !== 'false' && allowCommentsRaw !== false;

    let thumbnailPath: string | null = null;
    if (thumbnailFile) {
      const secureFilename = generateSecureFilename(thumbnailFile.originalname);
      thumbnailPath = `thumbnails/${userId}/${videoId}/${secureFilename}`;
    }

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          publicId: await generateUniqueVideoPublicId(tx.video),
          userId,
          title,
          description: description || null,
          tags: parseTags(tags),
          thumbnail: thumbnailPath,
          allowComments,
          license,
          storagePath,
        },
      });
      await syncUserVideoStats(tx, userId);
      return created;
    });

    let uploadedThumbnailPath: string | null = null;
    try {
      if (thumbnailFile && thumbnailPath) {
        const thumbnailStream = createReadStream(thumbnailFile.path);
        await uploadFile(BUCKETS.VIDEOS, thumbnailPath, thumbnailStream, thumbnailFile.size, {
          'Content-Type': thumbnailFile.mimetype,
          'uploaded-by': userId,
        });
        uploadedThumbnailPath = thumbnailPath;
      }

      const videoStream = createReadStream(videoFile.path);
      await uploadFile(BUCKETS.VIDEOS, originalPath, videoStream, videoFile.size, {
        'Content-Type': videoFile.mimetype,
        'uploaded-by': userId,
      });
    } catch (uploadError) {
      await removeUploadedObject(BUCKETS.VIDEOS, uploadedThumbnailPath, `video bundle ${videoId}`);
      await rollbackCreatedVideo(videoId, userId);
      throw uploadError;
    }

    addToProcessingQueue({ videoId, userId, originalPath: storagePath, qualities: VIDEO_QUALITIES });

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: {
        id: getPublicVideoId(video),
        title: video.title,
        thumbnailUrl: getProxiedThumbnailUrl(userId, videoId, thumbnailPath),
      },
    });
  } catch (error) {
    console.error('Video upload (bundle) error:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
};

export const initChunkedVideoUpload = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body.description === 'string' && req.body.description.length > 0
      ? req.body.description : null;
    const tags = parseTags(req.body.tags);
    const license = parseLicense(req.body.license);
    const totalSize = parsePositiveInteger(req.body.totalSize);
    const originalName = typeof req.body.originalName === 'string' ? req.body.originalName : 'video';
    const mimeType = typeof req.body.mimeType === 'string' && req.body.mimeType.length > 0
      ? req.body.mimeType : null;

    if (!title) { res.status(400).json({ error: 'Video title is required' }); return; }
    if (!totalSize) {
      res.status(400).json({ error: 'totalSize is required and must be a positive integer' });
      return;
    }

    const totalChunks = parsePositiveInteger(req.body.totalChunks) ?? getRequiredVideoChunkCount(totalSize);

    const uploadPlanError = validateChunkedVideoUploadPlan(totalSize, totalChunks);
    if (uploadPlanError) {
      res.status(400).json({
        error: uploadPlanError,
        limits: {
          chunkSizeMB: VIDEO_CHUNK_MB,
          maxChunks: MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS,
          maxTotalSizeMB: MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB,
        },
      });
      return;
    }

    const uploadId = crypto.randomUUID();
    const uploadDir = getChunkUploadDir(userId, uploadId);
    await fs.mkdir(uploadDir, { recursive: true });

    const allowComments = req.body.allowComments !== 'false' && req.body.allowComments !== false;

    const manifest: ChunkedVideoManifest = {
      uploadId, userId, title, description, tags, totalSize, totalChunks,
      receivedChunks: 0,
      originalName, mimeType, createdAt: new Date().toISOString(),
      allowComments,
      license
    };
    await writeChunkManifest(uploadDir, manifest);

    res.status(201).json({ uploadId, chunkSizeBytes: VIDEO_CHUNK_BYTES, chunkSizeMB: VIDEO_CHUNK_MB, totalChunks, totalSize });
  } catch (error) {
    console.error('Chunked video upload init error:', error);
    res.status(500).json({ error: 'Failed to initialize chunked upload' });
  }
};

export const uploadVideoChunk = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { uploadId } = req.params;
    const chunkFile = req.file;
    const chunkIndex = parseNonNegativeInteger(req.body.chunkIndex);

    if (!uploadId || !isSafeUploadId(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }
    if (!chunkFile) { res.status(400).json({ error: 'No chunk file provided' }); return; }
    if (chunkIndex === null) { res.status(400).json({ error: 'chunkIndex must be a non-negative integer' }); return; }
    if (chunkFile.size > VIDEO_CHUNK_BYTES) {
      res.status(413).json({ error: `Chunk is too large. Max size is ${VIDEO_CHUNK_MB}MB.` });
      return;
    }

    const uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) { res.status(404).json({ error: 'Chunk upload session not found' }); return; }
    if (manifest.userId !== userId) { res.status(403).json({ error: 'You are not authorized for this upload' }); return; }
    if (chunkIndex >= manifest.totalChunks) {
      res.status(400).json({ error: `chunkIndex must be between 0 and ${manifest.totalChunks - 1}` });
      return;
    }

    const expectedBytes = expectedChunkSize(manifest, chunkIndex);
    if (chunkFile.size !== expectedBytes) {
      res.status(400).json({ error: `Invalid chunk size for index ${chunkIndex}. Expected ${expectedBytes} bytes.` });
      return;
    }

    const finalChunkPath = getChunkPath(uploadDir, chunkIndex);

    const chunkAlreadyExisted = await fs.access(finalChunkPath).then(() => true).catch(() => false);
    await fs.rename(chunkFile.path, finalChunkPath);

    if (!chunkAlreadyExisted) {
      manifest.receivedChunks++;
      await writeChunkManifest(uploadDir, manifest);
    }

    const isComplete = manifest.receivedChunks === manifest.totalChunks;

    res.json({
      message: 'Chunk uploaded successfully',
      uploadId,
      chunkIndex,
      receivedChunks: manifest.receivedChunks,
      totalChunks: manifest.totalChunks,
      isComplete,
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
};

export const completeChunkedVideoUpload = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { uploadId } = req.params;
  const thumbnailFile = req.file;
  let uploadDir: string | null = null;
  let shouldCleanupUploadDir = false;

  try {
    if (!uploadId || !isSafeUploadId(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }

    if (thumbnailFile) {
      const validationError = await validateThumbnailRules(thumbnailFile);
      if (validationError) {
        res.status(validationError.status).json({ error: validationError.message });
        return;
      }
    }

    uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) { res.status(404).json({ error: 'Chunk upload session not found' }); return; }
    if (manifest.userId !== userId) { res.status(403).json({ error: 'You are not authorized for this upload' }); return; }

    if (manifest.receivedChunks !== manifest.totalChunks) {
      const uploadedChunkIndexes = await listUploadedChunkIndexes(uploadDir);
      const missingChunkIndexes = listMissingChunkIndexes(manifest.totalChunks, uploadedChunkIndexes);
      if (missingChunkIndexes.length > 0) {
        res.status(400).json({ error: 'Some chunks are missing', missingChunks: missingChunkIndexes });
        return;
      }
    }

    const assembledPath = getChunkAssembledPath(uploadDir);
    await assembleChunks(uploadDir, manifest.totalChunks, assembledPath);

    const assembledStat = await fs.stat(assembledPath);
    if (assembledStat.size !== manifest.totalSize) {
      res.status(400).json({ error: `Assembled file size mismatch. Expected ${manifest.totalSize}, got ${assembledStat.size}.` });
      return;
    }

    const detectedFileType = await fileTypeFromFile(assembledPath);
    if (!detectedFileType || !ALLOWED_VIDEO_MIME_TYPES.includes(detectedFileType.mime)) {
      res.status(400).json({ error: 'Invalid file type. The assembled file is not a supported video.' });
      return;
    }

    const contentType = manifest.mimeType && ALLOWED_VIDEO_MIME_TYPES.includes(manifest.mimeType)
      ? manifest.mimeType : detectedFileType.mime;

    const videoId = generateVideoId();
    const originalPath = videoOriginalPath(userId, videoId);
    const storagePath = `${BUCKETS.VIDEOS}/${originalPath}`;
    const thumbnailPath = thumbnailFile
      ? `thumbnails/${userId}/${videoId}/${generateSecureFilename(thumbnailFile.originalname)}`
      : null;

    const video = await prisma.$transaction(async (tx) => {
      const created = await tx.video.create({
        data: {
          id: videoId,
          publicId: await generateUniqueVideoPublicId(tx.video),
          userId,
          title: manifest.title,
          description: manifest.description,
          tags: manifest.tags,
          thumbnail: thumbnailPath,
          allowComments: manifest.allowComments,
          license: manifest.license,
          storagePath,
        },
      });
      await syncUserVideoStats(tx, userId);
      return created;
    });

    let uploadedThumbnailPath: string | null = null;
    try {
      if (thumbnailFile && thumbnailPath) {
        const thumbnailStream = createReadStream(thumbnailFile.path);
        await uploadFile(BUCKETS.VIDEOS, thumbnailPath, thumbnailStream, thumbnailFile.size, {
          'Content-Type': thumbnailFile.mimetype,
          'uploaded-by': userId,
        });
        uploadedThumbnailPath = thumbnailPath;
      }

      const stream = createReadStream(assembledPath);
      await uploadFile(BUCKETS.VIDEOS, originalPath, stream, assembledStat.size, {
        'Content-Type': contentType,
        'uploaded-by': userId,
      });
    } catch (uploadError) {
      await removeUploadedObject(BUCKETS.VIDEOS, uploadedThumbnailPath, `chunked video ${videoId}`);
      await rollbackCreatedVideo(videoId, userId);
      throw uploadError;
    }

    addToProcessingQueue({ videoId, userId, originalPath: storagePath, qualities: VIDEO_QUALITIES });
    shouldCleanupUploadDir = true;
    await cleanupChunkUpload(uploadDir);

    res.json({
      message: 'Video uploaded successfully and queued for processing',
      video: {
        id: getPublicVideoId(video),
        title: video.title,
        thumbnailUrl: getProxiedThumbnailUrl(userId, videoId, thumbnailPath),
      },
    });
  } catch (error) {
    console.error('Chunked video upload completion error:', error);
    res.status(500).json({ error: 'Failed to finalize chunked upload' });
  } finally {
    // Keep the chunk session on failure so the client can retry completion
    // or replace missing/corrupted chunks without restarting from scratch.
    if (uploadDir && !shouldCleanupUploadDir) {
      await cleanupAssembledChunkFile(uploadDir);
    }
  }
};

export const abortChunkedVideoUpload = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { uploadId } = req.params;

    if (!uploadId || !isSafeUploadId(uploadId)) { res.status(400).json({ error: 'Invalid uploadId' }); return; }

    const uploadDir = getChunkUploadDir(userId, uploadId);
    const manifest = await readChunkManifest(uploadDir);

    if (!manifest) { res.status(404).json({ error: 'Chunk upload session not found' }); return; }
    if (manifest.userId !== userId) { res.status(403).json({ error: 'You are not authorized for this upload' }); return; }

    await cleanupChunkUpload(uploadDir);
    res.json({ message: 'Chunked upload aborted successfully' });
  } catch (error) {
    console.error('Chunked video upload abort error:', error);
    res.status(500).json({ error: 'Failed to abort chunked upload' });
  }
};

export const uploadAvatar = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const avatarFile = req.file;
    if (!avatarFile) { res.status(400).json({ error: 'No avatar file provided' }); return; }

    const userId = req.user!.id;
    const secureFilename = generateSecureFilename(avatarFile.originalname);
    const newAvatarPath = avatarPath(userId, secureFilename);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });

    const stream = createReadStream(avatarFile.path);
    await uploadFile(BUCKETS.USERS, newAvatarPath, stream, avatarFile.size, {
      'Content-Type': avatarFile.mimetype,
      'uploaded-by': userId,
    });

    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: newAvatarPath } });

    if (user?.avatarUrl && user.avatarUrl !== newAvatarPath) {
      await minioClient.removeObject(BUCKETS.USERS, user.avatarUrl).catch((err) => {
        console.error('Failed to delete old avatar:', err);
      });
    }

    res.json({
      message: 'Avatar uploaded successfully',
      avatarUrl: getProxiedAssetUrl(userId, newAvatarPath),
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
};

export const uploadBanner = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const bannerFile = req.file;
    if (!bannerFile) { res.status(400).json({ error: 'No banner file provided' }); return; }

    const userId = req.user!.id;
    const secureFilename = generateSecureFilename(bannerFile.originalname);
    const newBannerPath = bannerPath(userId, secureFilename);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannerUrl: true },
    });

    const stream = createReadStream(bannerFile.path);
    await uploadFile(BUCKETS.USERS, newBannerPath, stream, bannerFile.size, {
      'Content-Type': bannerFile.mimetype,
      'uploaded-by': userId,
    });

    await prisma.user.update({ where: { id: userId }, data: { bannerUrl: newBannerPath } });

    if (user?.bannerUrl && user.bannerUrl !== newBannerPath) {
      await minioClient.removeObject(BUCKETS.USERS, user.bannerUrl).catch((err) => {
        console.error('Failed to delete old banner:', err);
      });
    }

    res.json({
      message: 'Banner uploaded successfully',
      bannerUrl: getProxiedAssetUrl(userId, newBannerPath),
    });
  } catch (error) {
    console.error('Banner upload error:', error);
    res.status(500).json({ error: 'Failed to upload banner' });
  }
};

export const getFileDownloadUrl = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
    const { bucket } = req.params;
    const rawObjectName =
      (typeof req.query.objectName === 'string' ? req.query.objectName : undefined) ??
      req.params.filename ??
      req.params[0];
    const objectName = normalizeStorageObjectName(rawObjectName);
    const requester = req.user;

    const rawExpiry = parseInt(req.query.expiry as string);
    const expiry = Number.isInteger(rawExpiry)
      ? Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, rawExpiry))
      : DEFAULT_EXPIRY_SECONDS;

    if (!requester) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!Object.values(BUCKETS).includes(bucket as any)) {
      res.status(400).json({ error: 'Invalid bucket name' });
      return;
    }

    if (!objectName) {
      res.status(400).json({ error: 'Object name is required' });
      return;
    }

    const target = parseStorageObjectTarget(bucket as StorageBucketName, objectName);

    if (!target) {
      res.status(400).json({ error: 'Invalid object path' });
      return;
    }

    if (target.bucket === 'users') {
      const user = await prisma.user.findUnique({
        where: { id: target.userId },
        select: {
          id: true,
          avatarUrl: true,
          bannerUrl: true,
        },
      });

      if (!user) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }

      const expectedObjectName =
        target.kind === 'user-avatar' ? user.avatarUrl : user.bannerUrl;

      if (!expectedObjectName || expectedObjectName !== objectName) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }

      if (requester.id !== user.id && !isStaffRole(requester.role)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    } else {
      const video = await prisma.video.findUnique({
        where: { id: target.videoId },
        select: {
          id: true,
          userId: true,
          thumbnail: true,
        },
      });

      if (!video || video.userId !== target.userId) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }

      if (requester.id !== video.userId && !isStaffRole(requester.role)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      if (target.kind === 'video-thumbnail') {
        if (!video.thumbnail || video.thumbnail !== objectName) {
          res.status(404).json({ error: 'Object not found' });
          return;
        }
      } else if (!objectName.startsWith(`${video.userId}/${video.id}/`)) {
        res.status(404).json({ error: 'Object not found' });
        return;
      }
    }

    try {
      await minioClient.statObject(bucket, objectName);
    } catch (error: any) {
      const code = error?.code || error?.name;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        res.status(404).json({ error: 'Object not found' });
        return;
      }
      throw error;
    }

    const url = await getFileUrl(bucket, objectName, expiry);
    res.json({ url, expiresIn: expiry, objectName });
  } catch (error) {
    console.error('Get file URL error:', error);
    res.status(500).json({ error: 'Failed to generate file URL' });
  }
};

export const updateThumbnail = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id: videoId } = req.params;
  const thumbnailFile = req.file;

  if (!thumbnailFile) { res.status(400).json({ error: 'No thumbnail file provided' }); return; }

  try {
    const validationError = await validateThumbnailRules(thumbnailFile);
    if (validationError) {
      res.status(validationError.status).json({ error: validationError.message });
      return;
    }

    const video = await resolveVideoByIdentifier(videoId, {
      id: true,
      userId: true,
      thumbnail: true,
    });
    if (!video) { res.status(404).json({ error: 'Video not found' }); return; }
    if (video.userId !== userId) {
      res.status(403).json({ error: 'You are not authorized to edit this video' });
      return;
    }

    const secureFilename = generateSecureFilename(thumbnailFile.originalname);
    const newThumbnailPath = `thumbnails/${userId}/${video.id}/${secureFilename}`;

    const stream = createReadStream(thumbnailFile.path);
    await uploadFile(BUCKETS.VIDEOS, newThumbnailPath, stream, thumbnailFile.size, {
      'Content-Type': thumbnailFile.mimetype,
      'uploaded-by': userId,
    });

    await prisma.video.update({ where: { id: video.id }, data: { thumbnail: newThumbnailPath } });

    if (video.thumbnail && video.thumbnail !== newThumbnailPath) {
      await minioClient.removeObject(BUCKETS.VIDEOS, video.thumbnail).catch((err) => {
        console.error('Failed to delete old thumbnail:', err);
      });
    }

    const thumbnailUrl = getProxiedThumbnailUrl(userId, video.id, newThumbnailPath);
    res.json({ message: 'Thumbnail updated successfully', thumbnailUrl });
  } catch (error) {
    console.error('Thumbnail update error:', error);
    res.status(500).json({ error: 'Failed to update thumbnail' });
  }
};
