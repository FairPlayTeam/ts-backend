import { describe, expect, spyOn, test } from 'bun:test';
import config from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { createUnavailableObjectStorage } from '../src/lib/objectStorage.js';
import { videoExternalResourceReconciler } from '../src/externalResources.instance.js';
import { videoObjectStorage } from '../src/objectStorage.instance.js';
import { createVideosService } from '../src/services/videos.service.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';
import { createUserMediaProcessor } from '../src/services/userMedia/userMedia.processor.js';
import {
  createVideoPublicId,
  VIDEO_PUBLIC_ID_PATTERN,
} from '../src/services/videos/videoPublicId.js';
import type { VideosDependencies } from '../src/services/videos/videos.dependencies.js';

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
      comment: prisma.comment,
      commentLike: prisma.commentLike,
      externalResourceTarget: prisma.externalResourceTarget,
      video: { ...prisma.video },
      videoArtifactGeneration: prisma.videoArtifactGeneration,
      videoRating: prisma.videoRating,
      videoSourceThumbnail: prisma.videoSourceThumbnail,
      videoUploadSession: prisma.videoUploadSession,
    } satisfies VideosDependencies['prisma'];
    const findCandidate = spyOn(testPrisma.video, 'findFirst').mockResolvedValue(null);
    const transaction = spyOn(testPrisma, '$transaction');
    const service = createVideosService({
      prisma: testPrisma,
      objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
      externalResources: videoExternalResourceReconciler,
      imageProcessor: createUserMediaProcessor({
        profileMediaMaxUploadBytes: config.profileMediaMaxUploadBytes,
      }),
      clock: {
        now: () => new Date(),
      },
      publicIdGenerator: {
        generate: createVideoPublicId,
      },
      logger,
      config: {
        maxPartCount: config.videoUpload.maxPartCount,
        maxUploadBytes: config.videoUpload.maxUploadBytes,
        partSizeBytes: config.videoUpload.partSizeBytes,
        sessionTtlSeconds: config.videoUpload.sessionTtlSeconds,
        userStorageQuotaBytes: config.videoUpload.userStorageQuotaBytes,
      },
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
