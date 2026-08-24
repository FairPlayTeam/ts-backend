import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createUserMediaProcessor } from '../../src/services/userMedia/userMedia.processor.js';
import { buildVideoArtifactManifest } from '../../src/services/videos/videoObjectKeys.js';
import { createVideoTranscodeRunner } from '../../src/services/videos/videoTranscodeRunner.js';
import type { ObjectStorage } from '../../src/lib/objectStorage.js';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import {
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoUploadSessionNotFoundError,
} from '../../src/services/videos.errors.js';
import { HOUR_MS } from '../../src/config/constants.js';
import {
  createPng,
  createTranscodeTestVideo,
  createVerifiedSession,
  readStoredObjectBuffer,
  uploadVideoSource,
} from './support/fixtures.js';
import { waitForTranscodeJob } from './support/videoArtifacts.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  createIntegrationApp,
  createIntegrationVideosService,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

const createOneShotBarrier = (participants: number, timeoutMs = 10_000): (() => Promise<void>) => {
  const outcome = Promise.withResolvers<void>();
  let arrivals = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return async () => {
    if (arrivals >= participants) {
      return;
    }

    arrivals += 1;
    if (arrivals === 1) {
      timeout = setTimeout(() => {
        outcome.reject(new Error(`Barrier timed out waiting for ${participants} participants`));
      }, timeoutMs);
      timeout.unref?.();
    }
    if (arrivals === participants) {
      if (timeout) {
        clearTimeout(timeout);
      }
      outcome.resolve();
    }
    await outcome.promise;
  };
};

describe('videos thumbnails integration', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('reconciles a reserved source thumbnail deleted with its video before PUT completion', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    let scenarioNow = new Date();
    const owner = await createVerifiedSession(runtime, {
      email: 'deleted-thumbnail-owner@example.com',
      username: 'deleted_thumb_owner',
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail reservation deleted before PUT',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: video.video.id,
      sizeBytes: 1,
    });
    await runtime.prisma.video.update({
      where: { id: video.video.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt: new Date(scenarioNow.getTime() - 8 * 24 * HOUR_MS),
      },
    });
    const putStarted = Promise.withResolvers<void>();
    const releasePut = Promise.withResolvers<void>();
    let writtenThumbnail:
      | {
          bucket: string;
          objectKey: string;
        }
      | undefined;
    const barrierStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        writtenThumbnail = {
          bucket: input.bucket ?? VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey: input.objectKey,
        };
        putStarted.resolve();
        await releasePut.promise;
        await activeRuntime.videoObjectStorage.putObject(input);
      },
    };
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: barrierStorage,
      clock: { now: () => scenarioNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      barrierStorage,
      controlledExternalResources,
      { now: () => scenarioNow },
    );
    const thumbnail = await createPng(900, 1200);
    const uploadPromise = controlledVideosService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: video.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });

    await Promise.race([
      putStarted.promise,
      delay(10_000).then(() => {
        throw new Error('Source thumbnail PUT barrier was not reached');
      }),
    ]);
    const reservedTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        generation: initialized.uploadSession.id,
        role: 'source_thumbnail',
      },
    });

    expect(reservedTarget).toMatchObject({
      goal: 'present',
      state: 'writing',
    });
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: { uploadSessionId: initialized.uploadSession.id },
      }),
    ).resolves.toBeNull();

    const rejectedBefore = new Date(scenarioNow.getTime() - 7 * 24 * HOUR_MS);
    await expect(
      controlledVideosService.deleteExpiredVideosPendingPurge({
        observedAt: scenarioNow,
        purgeBefore: rejectedBefore,
      }),
    ).resolves.toEqual({
      videosPendingPurgeDeleted: 1,
      videoPendingPurgeTargetsScheduled: 2,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: video.video.id },
      }),
    ).resolves.toBeNull();

    releasePut.resolve();
    await expect(uploadPromise).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: reservedTarget.id },
        select: {
          goal: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      quiescenceNotBefore: new Date(scenarioNow.getTime() + HOUR_MS),
      state: 'quiescing',
    });

    scenarioNow = new Date(scenarioNow.getTime() + HOUR_MS + 1);
    await expect(
      controlledVideosService.reconcilePendingExternalResources({ limit: 10 }),
    ).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: reservedTarget.id },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });

    if (!writtenThumbnail) {
      throw new Error('Reserved source thumbnail was not written after video deletion');
    }

    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: writtenThumbnail.bucket,
        objectKey: writtenThumbnail.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('counts source thumbnails in the video quota and blocks repeated near-limit reservations', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-quota-abuse@example.com',
      username: 'thumb_quota_abuse',
    });
    const noisyPixels = randomBytes(1280 * 720 * 3);
    const nearUploadLimitThumbnail = await sharp(noisyPixels, {
      raw: {
        width: 1280,
        height: 720,
        channels: 3,
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const normalized = await createUserMediaProcessor({
      profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    }).processVideoThumbnail({
      buffer: nearUploadLimitThumbnail,
      size: nearUploadLimitThumbnail.length,
    });

    expect(nearUploadLimitThumbnail.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(nearUploadLimitThumbnail.length).toBeLessThan(PROFILE_MEDIA_MAX_UPLOAD_BYTES);

    const videos = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        runtime?.videosService.createVideo({
          userId: owner.userId,
          title: `Thumbnail quota abuse ${index}`,
          description: null,
          tags: [],
          license: 'all_rights_reserved',
          visibility: 'unlisted',
          allowComments: true,
        }),
      ),
    );
    const quotaBytes = 3 + normalized.sizeBytes * 2;
    const quotaBoundService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      {
        userStorageQuotaBytes: quotaBytes,
      },
    );
    const sessions = [];

    for (const created of videos) {
      if (!created) {
        throw new Error('Quota abuse video creation did not return a video');
      }

      sessions.push(
        await quotaBoundService.initMultipartUpload({
          userId: owner.userId,
          videoId: created.video.id,
          sizeBytes: 1,
        }),
      );
    }

    for (let index = 0; index < 2; index += 1) {
      const created = videos[index];
      const session = sessions[index];

      if (!created || !session) {
        throw new Error('Quota abuse setup is incomplete');
      }

      await expect(
        quotaBoundService.uploadSourceThumbnail({
          userId: owner.userId,
          videoId: created.video.id,
          uploadSessionId: session.uploadSession.id,
          file: {
            buffer: nearUploadLimitThumbnail,
            size: nearUploadLimitThumbnail.length,
          },
        }),
      ).resolves.toMatchObject({
        thumbnail: {
          sizeBytes: normalized.sizeBytes,
        },
      });
    }

    const blockedVideo = videos[2];
    const blockedSession = sessions[2];

    if (!blockedVideo || !blockedSession) {
      throw new Error('Blocked quota abuse setup is incomplete');
    }

    await expect(
      quotaBoundService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: blockedVideo.video.id,
        uploadSessionId: blockedSession.uploadSession.id,
        file: {
          buffer: nearUploadLimitThumbnail,
          size: nearUploadLimitThumbnail.length,
        },
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const reserved = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: {
          in: ['source', 'source_thumbnail'],
        },
        state: {
          not: 'confirmed_absent',
        },
      },
      _sum: {
        expectedSizeBytes: true,
      },
    });

    expect(reserved._sum.expectedSizeBytes).toBe(BigInt(quotaBytes));
    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          userId: owner.userId,
          role: 'source_thumbnail',
        },
      }),
    ).resolves.toBe(2);
  });

  test('publishes the latest confirmed custom thumbnail, cleans its replacement, and serves the generation copy', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'custom-video-thumbnail@example.com',
      username: 'custom_thumb',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Custom video thumbnail',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const firstThumbnail = await createPng(320, 900);
    const secondThumbnail = await sharp({
      create: {
        width: 1_800,
        height: 300,
        channels: 3,
        background: '#f04444',
      },
    })
      .png()
      .toBuffer();
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo(),
      userId: owner.userId,
      videoId: created.video.id,
      thumbnails: [firstThumbnail, secondThumbnail],
    });
    const confirmedThumbnail = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: source.uploadSession.id,
      },
      include: {
        externalResourceTarget: true,
      },
    });
    const replacedTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        generation: source.uploadSession.id,
        role: 'source_thumbnail',
        id: {
          not: confirmedThumbnail.externalResourceTargetId,
        },
      },
    });
    const normalizedThumbnail = await readStoredObjectBuffer(
      runtime.videoObjectStorage,
      confirmedThumbnail.bucket,
      confirmedThumbnail.objectKey,
    );
    const normalizedMetadata = await sharp(normalizedThumbnail).metadata();

    expect(normalizedMetadata).toMatchObject({
      format: 'webp',
      width: 1280,
      height: 720,
    });
    expect(confirmedThumbnail.externalResourceTarget).toMatchObject({
      userId: owner.userId,
      videoId: created.video.id,
      generation: source.uploadSession.id,
      goal: 'present',
      role: 'source_thumbnail',
      state: 'confirmed_present',
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const reservedBeforeCleanup = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: {
          in: ['source', 'source_thumbnail'],
        },
        state: {
          not: 'confirmed_absent',
        },
      },
      _sum: {
        expectedSizeBytes: true,
      },
    });
    const expectedReservedBytes =
      BigInt(source.uploadSession.expectedSizeBytes) +
      (confirmedThumbnail.externalResourceTarget.expectedSizeBytes ?? 0n) +
      (replacedTarget.expectedSizeBytes ?? 0n);

    expect(reservedBeforeCleanup._sum.expectedSizeBytes).toBe(expectedReservedBytes);
    const quotaProbeVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail replacement quota probe',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const replacementQuotaService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      {
        maxUploadBytes: 1,
        userStorageQuotaBytes: Number(expectedReservedBytes),
      },
    );

    await expect(
      replacementQuotaService.initMultipartUpload({
        userId: owner.userId,
        videoId: quotaProbeVideo.video.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: replacedTarget.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: replacedTarget.bucket,
        objectKey: replacedTarget.selector,
      }),
    ).resolves.toBeNull();

    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
      },
    });
    const runnerErrors: object[] = [];
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (data) => {
          runnerErrors.push(data);
        },
      },
    });

    runner.start();
    let completedJob: Awaited<ReturnType<typeof waitForTranscodeJob>>;

    try {
      completedJob = await waitForTranscodeJob(runtime.prisma, job.id);
    } finally {
      await runner.stop();
    }

    expect(completedJob).toMatchObject({
      status: 'completed',
      lastError: null,
    });
    expect(runnerErrors).toEqual([]);
    const activeGeneration = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        state: 'active',
      },
      select: {
        bucket: true,
        id: true,
        thumbnailObjectKey: true,
      },
    });
    const manifest = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      activeGeneration.id,
      [],
    );

    expect(activeGeneration.thumbnailObjectKey).toBe(manifest.thumbnail.objectKey);
    await expect(
      readStoredObjectBuffer(
        runtime.videoObjectStorage,
        activeGeneration.bucket,
        manifest.thumbnail.objectKey,
      ),
    ).resolves.toEqual(normalizedThumbnail);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: confirmedThumbnail.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'quiescing',
    });

    const app = await createIntegrationApp(runtime);
    const thumbnailRedirect = await request(app)
      .get(`/videos/${created.video.publicId}/thumbnail`)
      .expect(307)
      .expect('Cache-Control', 'no-store');
    const signedThumbnailUrl = thumbnailRedirect.headers.location;

    if (!signedThumbnailUrl) {
      throw new Error('Public thumbnail redirect did not expose a Location header');
    }

    const signedThumbnail = await fetch(signedThumbnailUrl);

    expect(signedThumbnail.status).toBe(200);
    expect(Buffer.from(await signedThumbnail.arrayBuffer())).toEqual(normalizedThumbnail);
    await request(app)
      .get('/videos/me')
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.videos).toContainEqual(
          expect.objectContaining({
            id: created.video.id,
            processingStatus: 'ready',
            thumbnailPath: `/videos/${created.video.publicId}/thumbnail`,
          }),
        );
        expect(response.body.videos[0]).not.toHaveProperty('thumbnailObjectKey');
      });
  });

  test('cleans the confirmed thumbnail of a source replaced before its generation is published', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'replaced-source-thumbnail@example.com',
      username: 'replaced_src_thumb',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Replaced source thumbnail cleanup',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceA = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source A before publication'),
      userId: owner.userId,
      videoId: created.video.id,
      thumbnails: [await createPng(1600, 900)],
    });
    const thumbnailA = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: sourceA.uploadSession.id,
      },
      include: {
        externalResourceTarget: true,
      },
    });

    expect(thumbnailA.externalResourceTarget).toMatchObject({
      goal: 'present',
      state: 'confirmed_present',
    });
    await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source B replaces A before its job is claimed'),
      userId: owner.userId,
      videoId: created.video.id,
    });

    const scheduled = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: {
        id: thumbnailA.externalResourceTargetId,
      },
    });

    expect(scheduled).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: thumbnailA.externalResourceTargetId,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: thumbnailA.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: {
          uploadSessionId: sourceA.uploadSession.id,
        },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: thumbnailA.bucket,
        objectKey: thumbnailA.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('rejects thumbnail IDOR before creating an external reservation', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const [owner, otherUser] = await Promise.all([
      createVerifiedSession(runtime, {
        email: 'thumbnail-owner@example.com',
        username: 'thumb_owner',
      }),
      createVerifiedSession(runtime, {
        email: 'thumbnail-attacker@example.com',
        username: 'thumb_attacker',
      }),
    ]);
    const [ownedVideo, otherVideo] = await Promise.all([
      runtime.videosService.createVideo({
        userId: owner.userId,
        title: 'Owned thumbnail session',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      }),
      runtime.videosService.createVideo({
        userId: owner.userId,
        title: 'Other owned video',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      }),
    ]);
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: ownedVideo.video.id,
      sizeBytes: 64,
    });
    const thumbnail = await createPng();
    const countBefore = await runtime.prisma.externalResourceTarget.count({
      where: {
        role: 'source_thumbnail',
      },
    });

    await expect(
      runtime.videosService.uploadSourceThumbnail({
        userId: otherUser.userId,
        videoId: ownedVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(VideoUploadSessionNotFoundError);
    await expect(
      runtime.videosService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: otherVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(VideoUploadSessionNotFoundError);
    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          role: 'source_thumbnail',
        },
      }),
    ).resolves.toBe(countBefore);
  });

  test('serializes thumbnail and source finalization transactions released by the same barrier', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-finalization-barrier@example.com',
      username: 'thumb_final_barrier',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail finalization barrier',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceBody = Buffer.from('source finalized against thumbnail');
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: sourceBody.length,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const sourcePut = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body: sourceBody,
    });
    const etag = sourcePut.headers.get('etag');

    if (!etag) {
      throw new Error('Concurrent finalization source PUT did not return an ETag');
    }

    const thumbnailPrisma = createPrismaClient(runtime.databaseUrl);
    const completePrisma = createPrismaClient(runtime.databaseUrl);
    const lockPrisma = createPrismaClient(runtime.databaseUrl);
    const thumbnailStored = Promise.withResolvers<void>();
    const releaseThumbnailPut = Promise.withResolvers<void>();
    const bothHeadsCompleted = Promise.withResolvers<void>();
    const releaseHeads = Promise.withResolvers<void>();
    let completedHeads = 0;
    const barrierStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        await activeRuntime.videoObjectStorage.putObject(input);
        thumbnailStored.resolve();
        await releaseThumbnailPut.promise;
      },
      headObject: async (input) => {
        const object = await activeRuntime.videoObjectStorage.headObject(input);

        completedHeads += 1;
        if (completedHeads === 2) {
          bothHeadsCompleted.resolve();
        }
        await releaseHeads.promise;

        return object;
      },
    };
    const thumbnailExternalResources = createExternalResourceReconciler({
      prisma: thumbnailPrisma,
      objectStorage: barrierStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const completeExternalResources = createExternalResourceReconciler({
      prisma: completePrisma,
      objectStorage: barrierStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const thumbnailService = createIntegrationVideosService(
      thumbnailPrisma,
      barrierStorage,
      thumbnailExternalResources,
    );
    const completeService = createIntegrationVideosService(
      completePrisma,
      barrierStorage,
      completeExternalResources,
    );
    const thumbnail = await createPng(900, 1200);
    const thumbnailPromise = thumbnailService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });

    await thumbnailStored.promise;
    const completePromise = completeService.completeMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      parts: [{ partNumber: 1, etag }],
    });
    releaseThumbnailPut.resolve();

    await Promise.race([
      bothHeadsCompleted.promise,
      delay(10_000).then(() => {
        throw new Error('Both reconciliations did not reach HEAD verification');
      }),
    ]);

    const lockAcquired = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const lockTransaction = lockPrisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "video_upload_sessions" IN ACCESS EXCLUSIVE MODE');
        lockAcquired.resolve();
        await releaseLock.promise;
      },
      {
        timeout: 15_000,
      },
    );
    let blockedFinalizations = 0;

    try {
      await Promise.race([
        lockAcquired.promise,
        delay(5_000).then(() => {
          throw new Error('Finalization lock could not be acquired');
        }),
      ]);
      releaseHeads.resolve();

      const blockedDeadline = Date.now() + 5_000;

      while (Date.now() < blockedDeadline) {
        const [activity] = await runtime.prisma.$queryRaw<Array<{ blocked_count: number }>>`
          SELECT count(*)::int AS blocked_count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%video_upload_sessions%'
        `;
        blockedFinalizations = activity?.blocked_count ?? 0;

        if (blockedFinalizations >= 2) {
          break;
        }

        await delay(25);
      }
    } finally {
      releaseLock.resolve();
      releaseHeads.resolve();
      await lockTransaction;
      await lockPrisma.$disconnect();
    }

    let thumbnailResult: PromiseSettledResult<Awaited<typeof thumbnailPromise>>;
    let completeResult: PromiseSettledResult<Awaited<typeof completePromise>>;

    try {
      [thumbnailResult, completeResult] = await Promise.allSettled([
        thumbnailPromise,
        completePromise,
      ]);
    } finally {
      await Promise.all([thumbnailPrisma.$disconnect(), completePrisma.$disconnect()]);
    }

    expect(blockedFinalizations).toBeGreaterThanOrEqual(2);
    expect(completeResult.status).toBe('fulfilled');

    const [storedSession, thumbnailTargets] = await Promise.all([
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: {
          id: initialized.uploadSession.id,
        },
        include: {
          sourceThumbnail: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          generation: initialized.uploadSession.id,
          role: 'source_thumbnail',
        },
      }),
    ]);

    expect(storedSession.status).toBe('completed');
    expect(thumbnailTargets).toHaveLength(1);
    const thumbnailTarget = thumbnailTargets[0];

    if (!thumbnailTarget) {
      throw new Error('Concurrent thumbnail target was not persisted');
    }

    if (storedSession.sourceThumbnail) {
      expect(thumbnailResult.status).toBe('fulfilled');
      expect(storedSession.sourceThumbnail.externalResourceTargetId).toBe(thumbnailTarget.id);
      expect(thumbnailTarget).toMatchObject({
        goal: 'present',
        state: 'confirmed_present',
      });
    } else {
      expect(thumbnailResult.status).toBe('rejected');
      if (thumbnailResult.status === 'rejected') {
        expect(thumbnailResult.reason).toBeInstanceOf(InvalidVideoUploadSessionStateError);
      }
      expect(thumbnailTarget).toMatchObject({
        goal: 'absent',
        state: 'quiescing',
      });
    }
  });

  test('finalizes two parallel thumbnails with one winner and one fully tracked cleanup', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'parallel-thumbnails@example.com',
      username: 'parallel_thumbnails',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Parallel thumbnail replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: 1,
    });
    const firstPrisma = createPrismaClient(runtime.databaseUrl);
    const secondPrisma = createPrismaClient(runtime.databaseUrl);
    const putBarrier = createOneShotBarrier(2);
    const parallelStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        await activeRuntime.videoObjectStorage.putObject(input);
        await putBarrier();
      },
    };
    const firstExternalResources = createExternalResourceReconciler({
      prisma: firstPrisma,
      objectStorage: parallelStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const secondExternalResources = createExternalResourceReconciler({
      prisma: secondPrisma,
      objectStorage: parallelStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const firstService = createIntegrationVideosService(
      firstPrisma,
      parallelStorage,
      firstExternalResources,
    );
    const secondService = createIntegrationVideosService(
      secondPrisma,
      parallelStorage,
      secondExternalResources,
    );
    const [firstThumbnail, secondThumbnail] = await Promise.all([
      createPng(900, 900),
      createPng(1800, 600),
    ]);
    const firstUpload = firstService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: firstThumbnail,
        size: firstThumbnail.length,
      },
    });
    const secondUpload = secondService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: secondThumbnail,
        size: secondThumbnail.length,
      },
    });
    let first: PromiseSettledResult<Awaited<typeof firstUpload>>;
    let second: PromiseSettledResult<Awaited<typeof secondUpload>>;

    try {
      [first, second] = await Promise.allSettled([firstUpload, secondUpload]);
    } finally {
      await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
    }

    if (![first, second].some((result) => result.status === 'fulfilled')) {
      throw new AggregateError(
        [first, second].flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        'Both parallel thumbnail uploads failed',
      );
    }
    const [linkedThumbnail, targets] = await Promise.all([
      runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
        where: {
          uploadSessionId: initialized.uploadSession.id,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          generation: initialized.uploadSession.id,
          role: 'source_thumbnail',
        },
        orderBy: {
          createdAt: 'asc',
        },
      }),
    ]);

    expect(targets).toHaveLength(2);
    const winner = targets.find((target) => target.id === linkedThumbnail.externalResourceTargetId);
    const loser = targets.find((target) => target.id !== linkedThumbnail.externalResourceTargetId);

    expect(winner).toMatchObject({
      goal: 'present',
      state: 'confirmed_present',
    });
    expect(loser).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });

    if (!winner || !loser) {
      throw new Error('Parallel thumbnail winner and loser were not both persisted');
    }

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: loser.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: loser.id,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: loser.bucket,
        objectKey: loser.selector,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: winner.bucket,
        objectKey: winner.selector,
      }),
    ).resolves.toMatchObject({
      sizeBytes: linkedThumbnail.sizeBytes,
    });
  });

  test('discards a thumbnail whose PUT races with complete and transcodes with the ffmpeg fallback', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-complete-race@example.com',
      username: 'thumb_race',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail complete race',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceBody = await createTranscodeTestVideo();
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: sourceBody.length,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const sourcePut = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body: sourceBody,
    });
    const etag = sourcePut.headers.get('etag');

    if (!etag) {
      throw new Error('Multipart source upload did not return an ETag');
    }

    let racedThumbnail:
      | {
          body: Buffer;
          bucket: string;
          objectKey: string;
        }
      | undefined;
    const raceService = createIntegrationVideosService(
      runtime.prisma,
      {
        ...runtime.videoObjectStorage,
        putObject: async (input) => {
          await runtime?.videoObjectStorage.putObject(input);
          racedThumbnail = {
            body: input.body,
            bucket: input.bucket ?? VIDEO_OBJECT_STORAGE_BUCKET,
            objectKey: input.objectKey,
          };
          await runtime?.videosService.completeMultipartUpload({
            userId: owner.userId,
            videoId: created.video.id,
            uploadSessionId: initialized.uploadSession.id,
            parts: [{ partNumber: 1, etag }],
          });
        },
      },
      runtime.videoExternalResources,
    );
    const thumbnail = await createPng(300, 900);

    await expect(
      raceService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: created.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    expect(racedThumbnail).toBeDefined();
    const app = await createIntegrationApp(runtime);
    await request(app)
      .put(`/videos/${created.video.id}/upload/multipart/${initialized.uploadSession.id}/thumbnail`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .attach('thumbnail', thumbnail, {
        contentType: 'image/png',
        filename: 'late-thumbnail.png',
      })
      .expect(409);
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: {
          uploadSessionId: initialized.uploadSession.id,
        },
      }),
    ).resolves.toBeNull();

    const thumbnailTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        generation: initialized.uploadSession.id,
        role: 'source_thumbnail',
      },
    });
    expect(thumbnailTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: thumbnailTarget.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(raceService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    const writtenThumbnail = racedThumbnail as
      | { body: Buffer; bucket: string; objectKey: string }
      | undefined;

    if (!writtenThumbnail) {
      throw new Error('Raced thumbnail PUT was not observed');
    }

    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: writtenThumbnail.bucket,
        objectKey: writtenThumbnail.objectKey,
      }),
    ).resolves.toBeNull();

    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
      },
      select: {
        id: true,
      },
    });
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: testLogger,
    });

    runner.start();

    try {
      await expect(waitForTranscodeJob(runtime.prisma, job.id)).resolves.toMatchObject({
        status: 'completed',
        lastError: null,
      });
    } finally {
      await runner.stop();
    }

    const activeGeneration = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        state: 'active',
      },
      select: {
        bucket: true,
        id: true,
      },
    });
    const fallbackObjectKey = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      activeGeneration.id,
      [],
    ).thumbnail.objectKey;
    const fallbackThumbnail = await readStoredObjectBuffer(
      runtime.videoObjectStorage,
      activeGeneration.bucket,
      fallbackObjectKey,
    );

    expect(fallbackThumbnail).not.toEqual(writtenThumbnail.body);
    await expect(sharp(fallbackThumbnail).metadata()).resolves.toMatchObject({
      format: 'webp',
    });
  });

  test('keeps a custom-thumbnail generation writing and cleans it when poster HEAD verification fails', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'custom-thumbnail-head-failure@example.com',
      username: 'thumb_head_failure',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Custom thumbnail HEAD failure',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo(),
      userId: owner.userId,
      videoId: created.video.id,
      thumbnails: [await createPng(1600, 900)],
    });
    const sourceThumbnail = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: source.uploadSession.id,
      },
      select: {
        externalResourceTargetId: true,
      },
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
      },
    });
    let failedPosterKey: string | null = null;
    const verificationFailureStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      headObject: async (input) => {
        if (input.objectKey.endsWith('/thumbnail/poster.webp')) {
          failedPosterKey = input.objectKey;
          return null;
        }

        return runtime?.videoObjectStorage.headObject(input) ?? null;
      },
    };
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: verificationFailureStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: testLogger,
    });

    runner.start();
    let failedJob:
      | {
          attempts: number;
          lastError: string | null;
          status: 'queued' | 'processing' | 'completed' | 'failed';
        }
      | undefined;
    const retryDeadline = Date.now() + 40_000;

    try {
      while (Date.now() < retryDeadline) {
        const observed = await runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
          where: {
            id: job.id,
          },
          select: {
            attempts: true,
            lastError: true,
            status: true,
          },
        });

        if (observed.status === 'queued' && observed.attempts === 1 && observed.lastError) {
          failedJob = observed;
          break;
        }

        await delay(200);
      }
    } finally {
      await runner.stop();
    }

    expect(failedJob).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('Uploaded artifact could not be verified'),
      status: 'queued',
    });
    expect(failedPosterKey).toMatch(/\/thumbnail\/poster\.webp$/u);

    const generation = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
      },
      select: {
        id: true,
        state: true,
      },
    });
    const cleanupTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        generation: generation.id,
        role: {
          in: ['hls_artifacts', 'thumbnail_prefix'],
        },
      },
    });

    expect(generation.state).toBe('writing');
    expect(cleanupTargets).toHaveLength(2);
    expect(
      cleanupTargets.every((target) => target.goal === 'absent' && target.state === 'quiescing'),
    ).toBe(true);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: sourceThumbnail.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'present',
      state: 'confirmed_present',
    });

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.updateMany({
      where: {
        generation: generation.id,
        role: {
          in: ['hls_artifacts', 'thumbnail_prefix'],
        },
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 2,
      confirmed: 2,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: {
          id: generation.id,
        },
        select: {
          state: true,
        },
      }),
    ).resolves.toEqual({
      state: 'retired',
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        objectKey: failedPosterKey ?? '',
      }),
    ).resolves.toBeNull();
  });
});
