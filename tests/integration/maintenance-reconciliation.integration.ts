import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildVideoArtifactManifest } from '../../src/services/videos/videoObjectKeys.js';
import { createObjectStorage, ObjectStorageUnavailableError } from '../../src/lib/objectStorage.js';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import {
  createMaintenanceCleanupJob,
  createRedisMaintenanceCleanupLock,
} from '../../src/maintenance/cleanup.js';
import {
  INITIAL_PASSWORD,
  createPng,
  createVerifiedSession,
  uploadVideoSource,
} from './support/fixtures.js';
import { OBJECT_STORAGE_BUCKET, VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  createIntegrationAuthService,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

describe('maintenance and reconciliation integration', () => {
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

  test('claims reconciliation targets with exclusive leases and persists retry backoff', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const owner = await createVerifiedSession(runtime, {
      email: 'reconciliation-lease@example.com',
      username: 'reconcile_lease',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Reconciliation lease',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const objectKey = `${owner.userId}/${created.video.id}/lease-test/object.bin`;
    const body = Buffer.from('lease-protected-object');
    await runtime.videoObjectStorage.putObject({
      objectKey,
      body,
      contentType: 'application/octet-stream',
    });
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: objectKey,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: BigInt(body.length),
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    let signalPrepared: (() => void) | undefined;
    let releasePreparation: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      signalPrepared = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const firstReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      leaseIdGenerator: {
        generate: () => '11111111-1111-4111-8111-111111111111',
      },
      logger: testLogger,
    });
    const secondReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      leaseIdGenerator: {
        generate: () => '22222222-2222-4222-8222-222222222222',
      },
      logger: testLogger,
    });
    const firstRun = firstReconciler.reconcileTarget({
      targetId: target.id,
      roles: ['source'],
      handlers: {
        source: {
          preparePresent: async () => {
            signalPrepared?.();
            await preparationReleased;
          },
        },
      },
    });

    await prepared;
    await expect(
      secondReconciler.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
      }),
    ).resolves.toBe('skipped');
    releasePreparation?.();
    await expect(firstRun).resolves.toBe('confirmed');

    const missingTarget = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: `${objectKey}.missing`,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: 10n,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    const failedAt = Date.now();
    await expect(
      runtime.videoExternalResources.reconcileDue({
        roles: ['source'],
        limit: 1,
      }),
    ).resolves.toEqual({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 0,
      failed: 1,
    });
    const failedTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: { id: missingTarget.id },
    });

    expect(failedTarget).toMatchObject({
      state: 'writing',
      attempts: 1,
      lastError: 'Reserved external object is not present',
      reconciliationLeaseId: null,
      reconciliationLeaseExpiresAt: null,
    });
    expect(failedTarget.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(failedAt + 60_000);

    const longErrorTarget = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: `${objectKey}.long-error`,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: 10n,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    const longError = new Error('x'.repeat(1_500));
    const failingReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: {
        ...runtime.videoObjectStorage,
        headObject: async () => {
          throw longError;
        },
      },
      clock: { now: () => new Date() },
      logger: testLogger,
    });

    await expect(
      failingReconciler.reconcileTarget({
        targetId: longErrorTarget.id,
        roles: ['source'],
      }),
    ).rejects.toBe(longError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: longErrorTarget.id },
        select: { attempts: true, lastError: true },
      }),
    ).resolves.toEqual({
      attempts: 1,
      lastError: 'x'.repeat(1_000),
    });
  });

  test('requires a new claim after a reconciliation lease expires', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'expired-reconciliation-lease@example.com',
      username: 'expired_lease',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Expired reconciliation lease',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const objectKey = `${owner.userId}/${created.video.id}/expired-lease.bin`;
    const body = Buffer.from('expired lease object');
    await runtime.videoObjectStorage.putObject({
      objectKey,
      body,
      contentType: 'application/octet-stream',
    });
    let observedAt = new Date();
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: objectKey,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: BigInt(body.length),
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
        nextAttemptAt: observedAt,
      },
      select: { id: true },
    });
    const expiredOwner = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      leaseIdGenerator: {
        generate: () => '11111111-1111-4111-8111-111111111111',
      },
      logger: testLogger,
    });

    await expect(
      expiredOwner.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
        handlers: {
          source: {
            preparePresent: async () => {
              observedAt = new Date(observedAt.getTime() + 6 * 60 * 1000);
            },
          },
        },
      }),
    ).rejects.toThrow('External resource reconciliation lease was lost');
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          reconciliationLeaseId: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      reconciliationLeaseId: '11111111-1111-4111-8111-111111111111',
      state: 'reconciling',
    });

    const newOwner = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      leaseIdGenerator: {
        generate: () => '22222222-2222-4222-8222-222222222222',
      },
      logger: testLogger,
    });
    await expect(
      newOwner.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
      }),
    ).resolves.toBe('confirmed');
  });

  test('prevents a stale Redis lock owner from touching a lock reacquired after expiration', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const ttlMs = 100;
    const firstManager = createRedisMaintenanceCleanupLock({
      redisClient: runtime.redisClient,
      ttlMs,
      tokenFactory: () => 'expired-maintenance-instance',
    });
    const secondManager = createRedisMaintenanceCleanupLock({
      redisClient: runtime.redisClient,
      ttlMs: 5_000,
      tokenFactory: () => 'replacement-maintenance-instance',
    });
    const firstLock = await firstManager.acquire();

    if (!firstLock) {
      throw new Error('First maintenance lock was not acquired');
    }

    await delay(ttlMs * 2);
    const secondLock = await secondManager.acquire();

    if (!secondLock) {
      throw new Error('Replacement maintenance lock was not acquired after expiration');
    }

    await expect(firstLock.renew()).resolves.toBe(false);
    await firstLock.release();
    await expect(runtime.redisClient.call('get', 'maintenance:cleanup:lock')).resolves.toBe(
      'replacement-maintenance-instance',
    );
    expect(
      Number(await runtime.redisClient.call('pttl', 'maintenance:cleanup:lock')),
    ).toBeGreaterThan(0);
    await secondLock.release();
  });

  test('renews the real Redis maintenance lock, excludes a second instance, and detects token loss', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const firstStepStarted = Promise.withResolvers<void>();
    const releaseFirstStep = Promise.withResolvers<void>();
    const createMaintenanceServices = (calls: string[], blockFirstStep: boolean) => ({
      authService: {
        cleanupSessions: async () => {
          calls.push('sessions');

          if (blockFirstStep) {
            firstStepStarted.resolve();
            await releaseFirstStep.promise;
          }

          return {
            message: 'sessions cleaned',
            sessionsDeleted: 0,
          };
        },
        cleanupExpiredAuthTokens: async () => {
          calls.push('authTokens');
          return {
            message: 'tokens cleaned',
            emailVerificationTokensDeleted: 0,
            passwordResetTokensDeleted: 0,
          };
        },
        reconcileUserMediaTargets: async () => {
          calls.push('userMediaTargets');
          return {
            message: 'media reconciled',
            mediaTargetsConfirmed: 0,
            mediaTargetsFailed: 0,
          };
        },
      },
      videosService: {
        expireMultipartUploadSessions: async () => {
          calls.push('multipartSessions');
          return { uploadSessionsExpired: 0 };
        },
        scheduleAbandonedArtifactGenerations: async () => {
          calls.push('abandonedArtifactGenerations');
          return { artifactGenerationsScheduled: 0 };
        },
        reconcilePendingExternalResources: async () => {
          calls.push('videoTargets');
          return {
            claimed: 0,
            confirmed: 0,
            redirectedAbsent: 0,
            failed: 0,
          };
        },
        deleteExpiredVideosPendingPurge: async () => {
          calls.push('videosPendingPurge');
          return {
            videosPendingPurgeDeleted: 0,
            videoPendingPurgeTargetsScheduled: 0,
          };
        },
      },
    });
    const lockTtlMs = 300;
    const firstJob = createMaintenanceCleanupJob({
      ...createMaintenanceServices(firstCalls, true),
      clock: { now: () => new Date() },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock: createRedisMaintenanceCleanupLock({
        redisClient: runtime.redisClient,
        ttlMs: lockTtlMs,
        tokenFactory: () => 'first-maintenance-instance',
      }),
      logger: testLogger,
    });
    const secondJob = createMaintenanceCleanupJob({
      ...createMaintenanceServices(secondCalls, false),
      clock: { now: () => new Date() },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock: createRedisMaintenanceCleanupLock({
        redisClient: runtime.redisClient,
        ttlMs: lockTtlMs,
        tokenFactory: () => 'second-maintenance-instance',
      }),
      logger: testLogger,
    });

    const firstRun = firstJob.runOnce();
    await firstStepStarted.promise;
    await delay(lockTtlMs * 2);
    const secondResult = await secondJob.runOnce();
    await runtime.redisClient.call(
      'set',
      'maintenance:cleanup:lock',
      'intruder-token',
      'PX',
      '5000',
    );
    await delay(150);
    releaseFirstStep.resolve();
    const firstResult = await firstRun;
    const retainedToken = await runtime.redisClient.call('get', 'maintenance:cleanup:lock');
    await runtime.redisClient.call('del', 'maintenance:cleanup:lock');

    expect(secondResult).toEqual({
      skipped: true,
      lockLost: false,
      summary: {},
      failedSteps: [],
    });
    expect(secondCalls).toEqual([]);
    expect(firstCalls).toEqual(['sessions']);
    expect(firstResult).toEqual({
      skipped: false,
      lockLost: true,
      summary: {
        sessionsDeleted: 0,
      },
      failedSteps: ['lockOwnership'],
    });
    expect(retainedToken).toBe('intruder-token');
  });

  test('maintenance expires multipart sessions and schedules only abandoned writing generations', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const observedAt = new Date('2026-07-24T12:00:00.000Z');
    const staleAt = new Date(observedAt.getTime() - 60_000);
    const owner = await createVerifiedSession(runtime, {
      email: 'maintenance-video@example.com',
      username: 'maintenance_video',
    });
    const expiringVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Expired multipart',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const expiringUpload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: expiringVideo.video.id,
      sizeBytes: 128,
    });
    await runtime.prisma.videoUploadSession.update({
      where: { id: expiringUpload.uploadSession.id },
      data: { expiresAt: staleAt },
    });

    const createWritingGeneration = async ({ live, title }: { live: boolean; title: string }) => {
      const created = await runtime?.videosService.createVideo({
        userId: owner.userId,
        title,
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });

      if (!runtime || !created) {
        throw new Error('Integration runtime disappeared');
      }

      const source = await uploadVideoSource(runtime.videosService, {
        body: Buffer.from(`${title} source`),
        userId: owner.userId,
        videoId: created.video.id,
      });
      const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
        where: {
          videoId: created.video.id,
          sourceObjectKey: source.uploadSession.objectKey,
        },
        select: { id: true },
      });
      const executionId = randomUUID();

      if (live) {
        await runtime.prisma.videoTranscodeJob.update({
          where: { id: job.id },
          data: {
            status: 'processing',
            attempts: 1,
            executionId,
            heartbeatAt: observedAt,
            startedAt: observedAt,
          },
        });
      }

      const generationId = randomUUID();
      const manifest = buildVideoArtifactManifest(owner.userId, created.video.id, generationId, []);
      await runtime.prisma.videoArtifactGeneration.create({
        data: {
          id: generationId,
          videoId: created.video.id,
          sourceUploadSessionId: source.uploadSession.id,
          transcodeJobId: job.id,
          executionId,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          state: 'writing',
          hlsMasterObjectKey: manifest.master.objectKey,
          thumbnailObjectKey: manifest.thumbnail.objectKey,
          updatedAt: staleAt,
        },
      });
      await runtime.prisma.externalResourceTarget.createMany({
        data: [
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: manifest.hlsPrefix,
            selectorKind: 'prefix',
            role: 'hls_artifacts',
            generation: generationId,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'writing',
            nextAttemptAt: new Date(observedAt.getTime() + 60 * 60 * 1000),
          },
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: manifest.thumbnailPrefix,
            selectorKind: 'prefix',
            role: 'thumbnail_prefix',
            generation: generationId,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'writing',
            nextAttemptAt: new Date(observedAt.getTime() + 60 * 60 * 1000),
          },
        ],
      });

      return { generationId };
    };

    const abandoned = await createWritingGeneration({
      live: false,
      title: 'Abandoned generation',
    });
    const live = await createWritingGeneration({
      live: true,
      title: 'Live generation',
    });
    const maintenanceExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      logger: testLogger,
    });
    const cleanup = createMaintenanceCleanupJob({
      authService: runtime.authService,
      videosService: createIntegrationVideosService(
        runtime.prisma,
        runtime.videoObjectStorage,
        maintenanceExternalResources,
      ),
      clock: { now: () => observedAt },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 30 * 24 * 60 * 60 * 1000,
      },
      logger: testLogger,
    });

    const result = await cleanup.runOnce();
    expect(result).toMatchObject({
      skipped: false,
      lockLost: false,
      failedSteps: [],
      summary: {
        uploadSessionsExpired: 1,
        artifactGenerationsScheduled: 1,
        videoTargetsClaimed: 0,
        videoTargetsConfirmed: 0,
        videoTargetsFailed: 0,
      },
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: expiringUpload.uploadSession.id },
        select: {
          externalResourceTarget: {
            select: {
              goal: true,
              quiescenceNotBefore: true,
              state: true,
            },
          },
          status: true,
        },
      }),
    ).resolves.toEqual({
      status: 'expiring',
      externalResourceTarget: {
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: new Date(observedAt.getTime() + 60 * 60 * 1000),
      },
    });
    const [abandonedTargets, liveTargets] = await Promise.all([
      runtime.prisma.externalResourceTarget.findMany({
        where: { generation: abandoned.generationId },
        select: {
          attempts: true,
          goal: true,
          nextAttemptAt: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: { generation: live.generationId },
        select: {
          goal: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
    ]);
    expect(abandonedTargets).toHaveLength(2);
    expect(
      abandonedTargets.every(
        (target) =>
          target.attempts === 0 &&
          target.goal === 'absent' &&
          target.state === 'quiescing' &&
          target.quiescenceNotBefore?.getTime() === observedAt.getTime() + 60 * 60 * 1000 &&
          target.nextAttemptAt.getTime() === observedAt.getTime() + 60 * 60 * 1000,
      ),
    ).toBe(true);
    expect(liveTargets).toEqual([
      {
        goal: 'present',
        quiescenceNotBefore: null,
        state: 'writing',
      },
      {
        goal: 'present',
        quiescenceNotBefore: null,
        state: 'writing',
      },
    ]);
  });

  test('does not confirm absence from an unrecognized proxy 404', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'proxy-404-retry@example.com',
      username: 'proxy_404_retry',
    });
    const generation = randomUUID();
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: null,
        bucket: OBJECT_STORAGE_BUCKET,
        selector: `users/${owner.userId}/avatar/${generation}.webp`,
        selectorKind: 'exact',
        role: 'user_media',
        generation,
        expectedSizeBytes: 128n,
        mayHaveMultipartUpload: false,
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: new Date(Date.now() - 1_000),
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
      select: { id: true },
    });
    const proxyStorage = createObjectStorage(
      runtime.objectStorageConfig,
      {
        bucketExists: async () => true,
        makeBucket: async () => undefined,
        putObject: async () => undefined,
        removeObject: async () => undefined,
        statObject: async () => {
          const err = new Error('proxy route missing') as Error & {
            code: string;
            statusCode: number;
          };
          err.code = 'ProxyRouteNotFound';
          err.statusCode = 404;
          throw err;
        },
        presignedGetObject: async () => 'http://localhost/not-used',
      },
      testLogger,
    );
    const proxyReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: proxyStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });

    await expect(
      proxyReconciler.reconcileTarget({
        targetId: target.id,
        roles: ['user_media'],
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          attempts: true,
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      attempts: 1,
      goal: 'absent',
      state: 'quiescing',
    });
  });

  test('deletes an account while retaining durable cleanup for media, sources, and generation prefixes', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'account-cleanup@example.com',
      username: 'account_cleanup',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Account cleanup resources',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('account cleanup source'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: avatar,
        size: avatar.length,
      },
    });

    const [sourceSession, transcodeJob, mediaAsset] = await Promise.all([
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: source.uploadSession.id },
        select: {
          externalResourceTargetId: true,
          objectKey: true,
        },
      }),
      runtime.prisma.videoTranscodeJob.findFirstOrThrow({
        where: { videoId: created.video.id },
        select: { id: true },
      }),
      runtime.prisma.userMediaAsset.findFirstOrThrow({
        where: {
          userId: owner.userId,
          kind: 'avatar',
        },
        select: {
          bucket: true,
          externalResourceTargetId: true,
          objectKey: true,
        },
      }),
    ]);
    const generation = randomUUID();
    const generationPrefix = `${owner.userId}/${created.video.id}/generations/${generation}/hls/`;
    const thumbnailPrefix = `${owner.userId}/${created.video.id}/generations/${generation}/thumbnail/`;
    const masterObjectKey = `${generationPrefix}master.m3u8`;
    const segmentObjectKey = `${generationPrefix}480p/segment-000.ts`;
    const thumbnailObjectKey = `${thumbnailPrefix}poster.webp`;

    await Promise.all([
      runtime.videoObjectStorage.putObject({
        objectKey: masterObjectKey,
        body: Buffer.from('#EXTM3U'),
        contentType: 'application/vnd.apple.mpegurl',
      }),
      runtime.videoObjectStorage.putObject({
        objectKey: segmentObjectKey,
        body: Buffer.from('segment'),
        contentType: 'video/mp2t',
      }),
      runtime.videoObjectStorage.putObject({
        objectKey: thumbnailObjectKey,
        body: Buffer.from('thumbnail'),
        contentType: 'image/webp',
      }),
    ]);

    const artifactGeneration = await runtime.prisma.videoArtifactGeneration.create({
      data: {
        id: generation,
        videoId: created.video.id,
        sourceUploadSessionId: source.uploadSession.id,
        transcodeJobId: transcodeJob.id,
        executionId: randomUUID(),
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        state: 'active',
        hlsMasterObjectKey: masterObjectKey,
        thumbnailObjectKey,
        activatedAt: new Date(),
      },
      select: { id: true },
    });
    await Promise.all([
      runtime.prisma.video.update({
        where: { id: created.video.id },
        data: {
          activeArtifactGenerationId: artifactGeneration.id,
          hlsMasterObjectKey: masterObjectKey,
          thumbnailObjectKey,
          processingStatus: 'ready',
          durationSeconds: 30,
        },
      }),
      runtime.prisma.externalResourceTarget.createMany({
        data: [
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: generationPrefix,
            selectorKind: 'prefix',
            role: 'hls_artifacts',
            generation,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'confirmed_present',
          },
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: thumbnailPrefix,
            selectorKind: 'prefix',
            role: 'thumbnail_prefix',
            generation,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'confirmed_present',
          },
        ],
      }),
    ]);

    const deletion = await runtime.authService.deleteAccount({
      userId: owner.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    expect(deletion).toMatchObject({
      mediaCleanupQueued: 1,
      externalCleanupQueued: 4,
    });
    await expect(
      runtime.prisma.user.findUnique({ where: { id: owner.userId } }),
    ).resolves.toBeNull();
    await expect(runtime.prisma.video.count({ where: { ownerId: owner.userId } })).resolves.toBe(0);
    await expect(
      runtime.prisma.videoArtifactGeneration.count({
        where: { id: artifactGeneration.id },
      }),
    ).resolves.toBe(0);

    const queuedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: {
        id: true,
        role: true,
        state: true,
      },
      orderBy: { role: 'asc' },
    });
    expect(queuedTargets).toHaveLength(4);
    expect(queuedTargets.every(({ state }) => state === 'quiescing')).toBe(true);
    expect(queuedTargets.map(({ role }) => role).sort()).toEqual([
      'hls_artifacts',
      'source',
      'thumbnail_prefix',
      'user_media',
    ]);

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.updateMany({
      where: { userId: owner.userId },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      Promise.all([
        runtime.videoExternalResources.reconcileDue({
          roles: ['source', 'hls_artifacts', 'thumbnail_prefix'],
          limit: 10,
        }),
        runtime.userMediaExternalResources.reconcileDue({
          roles: ['user_media'],
          limit: 10,
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ claimed: 3, confirmed: 3, failed: 0 }),
      expect.objectContaining({ claimed: 1, confirmed: 1, failed: 0 }),
    ]);

    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          userId: owner.userId,
          state: { not: 'confirmed_absent' },
        },
      }),
    ).resolves.toBe(0);
    await Promise.all([
      expect(
        runtime.videoObjectStorage.headObject({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey: sourceSession.objectKey,
        }),
      ).resolves.toBeNull(),
      expect(
        runtime.objectStorage.headObject({
          bucket: mediaAsset.bucket,
          objectKey: mediaAsset.objectKey,
        }),
      ).resolves.toBeNull(),
      expect(
        runtime.videoObjectStorage.listObjects({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          prefix: generationPrefix,
          limit: 1,
        }),
      ).resolves.toEqual({ objects: [], truncated: false }),
      expect(
        runtime.videoObjectStorage.listObjects({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          prefix: thumbnailPrefix,
          limit: 1,
        }),
      ).resolves.toEqual({ objects: [], truncated: false }),
    ]);
    expect(queuedTargets.map(({ id }) => id)).toContain(sourceSession.externalResourceTargetId);
    expect(queuedTargets.map(({ id }) => id)).toContain(mediaAsset.externalResourceTargetId);
  });

  test('keeps concurrent account deletions idempotent without creating cleanup targets', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'concurrent-account-delete@example.com',
      username: 'concurrent_delete',
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: avatar,
        size: avatar.length,
      },
    });
    const targetsBefore = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let arrivals = 0;
    let release: (() => void) | null = null;
    const bothReauthenticated = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const deletionService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
      {
        afterPasswordCompare: async () => {
          arrivals += 1;

          if (arrivals === 2) {
            release?.();
          }

          await bothReauthenticated;
        },
      },
    );

    const deletions = await Promise.all([
      deletionService.deleteAccount({
        userId: owner.userId,
        currentPassword: INITIAL_PASSWORD,
      }),
      deletionService.deleteAccount({
        userId: owner.userId,
        currentPassword: INITIAL_PASSWORD,
      }),
    ]);

    expect(deletions).toEqual([
      expect.objectContaining({
        externalCleanupQueued: 1,
        mediaCleanupQueued: 1,
      }),
      expect.objectContaining({
        externalCleanupQueued: 1,
        mediaCleanupQueued: 1,
      }),
    ]);
    await expect(
      runtime.prisma.user.findUnique({
        where: { id: owner.userId },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.userMediaAsset.count({
        where: { userId: owner.userId },
      }),
    ).resolves.toBe(0);

    const targetsAfter = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: {
        goal: true,
        id: true,
        quiescenceNotBefore: true,
        state: true,
      },
      orderBy: { id: 'asc' },
    });

    expect(targetsAfter.map(({ id }) => ({ id }))).toEqual(targetsBefore);
    expect(targetsAfter).toEqual([
      expect.objectContaining({
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      }),
    ]);
  });
});
