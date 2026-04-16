import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { isUUID } from './utils.js';

const SHORT_VIDEO_ID_LENGTH = 10;
const SHORT_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{10}$/;
const MAX_GENERATION_ATTEMPTS = 20;
const BACKFILL_BATCH_SIZE = 100;

type VideoLookupClient = {
  findUnique: (args: {
    where: { publicId: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
};

export const isShortVideoId = (value: string): boolean =>
  SHORT_VIDEO_ID_PATTERN.test(value.trim());

export const generateVideoPublicId = (): string =>
  crypto.randomBytes(8).toString('base64url').slice(0, SHORT_VIDEO_ID_LENGTH);

export const getPublicVideoId = (video: {
  id: string;
  publicId?: string | null;
}): string => video.publicId ?? video.id;

export const generateUniqueVideoPublicId = async (
  client: VideoLookupClient = prisma.video,
): Promise<string> => {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = generateVideoPublicId();
    const existing = await client.findUnique({
      where: { publicId: candidate },
      select: { id: true },
    });

    if (!existing) {
      return candidate;
    }
  }

  throw new Error('Failed to generate a unique public video ID');
};

export const resolveVideoByIdentifier = async <
  TSelect extends Prisma.VideoSelect,
>(
  identifier: string,
  select: TSelect,
): Promise<Prisma.VideoGetPayload<{ select: TSelect }> | null> => {
  const normalizedIdentifier = identifier.trim();

  if (isUUID(normalizedIdentifier)) {
    return prisma.video.findUnique({
      where: { id: normalizedIdentifier },
      select,
    });
  }

  if (!isShortVideoId(normalizedIdentifier)) {
    return null;
  }

  return prisma.video.findUnique({
    where: { publicId: normalizedIdentifier },
    select,
  });
};

export const ensureVideoPublicId = async (videoId: string): Promise<string> => {
  const current = await prisma.video.findUnique({
    where: { id: videoId },
    select: { publicId: true },
  });

  if (!current) {
    throw new Error(`Video ${videoId} not found`);
  }

  if (current.publicId) {
    return current.publicId;
  }

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = await generateUniqueVideoPublicId();

    try {
      const result = await prisma.video.updateMany({
        where: { id: videoId, publicId: null },
        data: { publicId: candidate },
      });

      if (result.count > 0) {
        return candidate;
      }

      const concurrent = await prisma.video.findUnique({
        where: { id: videoId },
        select: { publicId: true },
      });

      if (concurrent?.publicId) {
        return concurrent.publicId;
      }

      continue;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed to assign a public video ID to ${videoId}`);
};

export const backfillMissingVideoPublicIds = async (): Promise<number> => {
  let updatedCount = 0;

  while (true) {
    const missingVideos = await prisma.video.findMany({
      where: { publicId: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: BACKFILL_BATCH_SIZE,
    });

    if (missingVideos.length === 0) {
      return updatedCount;
    }

    for (const video of missingVideos) {
      await ensureVideoPublicId(video.id);
      updatedCount += 1;
    }
  }
};
