import { describe, expect, spyOn, test } from 'bun:test';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { createUnavailableObjectStorage } from '../src/lib/objectStorage.js';
import { videoObjectStorage } from '../src/objectStorage.instance.js';
import { createVideosService } from '../src/modules/videos/index.js';
import { VideoNotFoundError } from '../src/modules/videos/shared/errors.js';
import {
  createVideoPublicId,
  VIDEO_PUBLIC_ID_PATTERN,
} from '../src/modules/videos/shared/publicId.js';
import type { VideosDependencies } from '../src/modules/videos/dependencies.js';

describe('video identifiers', () => {
  test('generates v1-compatible short public ids', () => {
    expect(createVideoPublicId()).toMatch(VIDEO_PUBLIC_ID_PATTERN);
  });

  test('does not collapse generated ids to a deterministic value', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createVideoPublicId()));

    expect(ids.size).toBe(100);
  });
});

describe('owned video deletion authorization', () => {
  test('requires an owner-qualified candidate before entering the hard-delete transaction', async () => {
    const testPrisma = {
      $executeRaw: prisma.$executeRaw,
      $queryRaw: prisma.$queryRaw,
      $transaction: prisma.$transaction,
      externalResourceTarget: prisma.externalResourceTarget,
      video: { ...prisma.video },
      videoArtifactGeneration: prisma.videoArtifactGeneration,
      videoRating: prisma.videoRating,
      videoTranscodeJob: prisma.videoTranscodeJob,
    } satisfies VideosDependencies['prisma'];
    const findCandidate = spyOn(testPrisma.video, 'findFirst').mockResolvedValue(null);
    const transaction = spyOn(testPrisma, '$transaction');
    const service = createVideosService({
      prisma: testPrisma,
      objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
      clock: {
        now: () => new Date(),
      },
      publicIdGenerator: {
        generate: createVideoPublicId,
      },
      logger,
    });
    const publicId = 'AbCdEf123_';
    const callerId = '11111111-1111-4111-8111-111111111111';

    try {
      await expect(
        service.deleteVideo({
          publicId,
          userId: callerId,
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundError);
      expect(findCandidate).toHaveBeenCalledWith({
        where: {
          publicId,
          ownerId: callerId,
        },
        select: {
          id: true,
        },
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      findCandidate.mockRestore();
      transaction.mockRestore();
    }
  });
});
