import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import { createMaintenanceCleanupJob } from '../../src/maintenance/cleanup.js';
import { HOUR_MS } from '../../src/config/constants.js';
import { createPng, createVerifiedSession, uploadVideoSource } from './support/fixtures.js';
import { reserveHlsArtifactTargets, seedHlsGeneration } from './support/videoArtifacts.js';
import {
  createIntegrationAdminService,
  createIntegrationApp,
  createIntegrationVideosService,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

const waitForBlockedVideoQueries = async (
  prisma: PrismaClient,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity] = await prisma.$queryRaw<Array<{ blocked_count: number }>>`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "videos"%'
    `;

    if ((activity?.blocked_count ?? 0) >= expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for ${expectedCount} blocked video queries`);
};

describe('videos moderation integration', () => {
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

  test('authorizes moderators and persists idempotent decisions with filtered cursor pagination', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    let moderationNow = new Date('2026-02-01T12:00:00.000Z');
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => moderationNow,
      ),
    });
    const owner = await createVerifiedSession(runtime, {
      email: 'moderation-owner@example.com',
      username: 'moderation_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'moderation-staff@example.com',
      username: 'moderation_staff',
    });
    const ordinaryUser = await createVerifiedSession(runtime, {
      email: 'moderation-user@example.com',
      username: 'moderation_user',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const createVideo = (title: string, tags: string[] = []) =>
      activeRuntime.videosService.createVideo({
        userId: owner.userId,
        title,
        description: null,
        tags,
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });
    const approved = await createVideo('Approve unlisted');

    await request(app)
      .get('/moderation/videos')
      .set('Authorization', `Bearer ${ordinaryUser.sessionKey}`)
      .expect(403);
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${ordinaryUser.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(403);
    await request(app)
      .post(`/moderation/videos/${randomUUID()}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(404)
      .expect({
        error: 'NotFound',
        message: 'Video not found',
      });

    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200)
      .expect((response) => {
        expect(response.body.video).toMatchObject({
          id: approved.video.id,
          moderationStatus: 'approved',
          visibility: 'public',
          publishedAt: moderationNow.toISOString(),
        });
      });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: moderationNow,
      rejectedAt: null,
      visibility: 'public',
    });

    moderationNow = new Date('2026-02-02T12:00:00.000Z');
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'rejected',
      publishedAt: new Date('2026-02-01T12:00:00.000Z'),
      rejectedAt: moderationNow,
      visibility: 'unlisted',
    });

    moderationNow = new Date('2026-02-03T12:00:00.000Z');
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: new Date('2026-02-01T12:00:00.000Z'),
      rejectedAt: null,
      visibility: 'public',
    });

    const rejected = await createVideo('Rejected list item');
    await request(app)
      .post(`/moderation/videos/${rejected.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);

    const pendingVideos = await Promise.all([
      createVideo('Pending oldest'),
      createVideo('Pending middle'),
      createVideo('Pending newest'),
    ]);

    const pendingDates = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
    ] as const;
    await Promise.all(
      pendingVideos.map((video, index) =>
        activeRuntime.prisma.video.update({
          where: { id: video.video.id },
          data: {
            createdAt: pendingDates[index] ?? pendingDates[0],
            processingStatus: 'ready',
          },
        }),
      ),
    );
    await runtime.prisma.video.update({
      where: { id: approved.video.id },
      data: { processingStatus: 'ready' },
    });
    await runtime.prisma.video.update({
      where: { id: rejected.video.id },
      data: { processingStatus: 'failed' },
    });

    const firstPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        sort: 'oldest',
        search: 'pending',
        limit: 2,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(firstPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending oldest',
      'Pending middle',
    ]);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.nextCursor).toEqual({
      createdAt: pendingDates[1]?.toISOString(),
      id: pendingVideos[1]?.video.id,
    });

    const secondPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        sort: 'oldest',
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorId: firstPage.body.nextCursor.id,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(secondPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending newest',
    ]);
    expect(secondPage.body.nextCursor).toBeNull();

    const newestPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        limit: 3,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(newestPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending newest',
      'Pending middle',
      'Pending oldest',
    ]);

    const literalWildcardVideo = await createVideo('Literal 100% match');
    const literalWildcardSearch = await request(app)
      .get('/moderation/videos')
      .query({ search: '%' })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(literalWildcardSearch.body).toEqual({
      videos: [
        expect.objectContaining({
          id: literalWildcardVideo.video.id,
          title: 'Literal 100% match',
        }),
      ],
      total: 1,
      nextCursor: null,
    });

    const tagOnlyVideo = await createVideo('Title unrelated to its moderation tag', [
      'moderation-tag-only',
    ]);
    const tagOnlySearch = await request(app)
      .get('/moderation/videos')
      .query({ search: 'moderation-tag-only' })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(tagOnlySearch.body).toEqual({
      videos: [
        expect.objectContaining({
          id: tagOnlyVideo.video.id,
          title: 'Title unrelated to its moderation tag',
        }),
      ],
      total: 1,
      nextCursor: null,
    });
  });

  test('keeps the first rejection timestamp and purges after its original seven-day window', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const rejectionStartedAt = new Date('2026-03-01T00:00:00.000Z');
    let moderationNow = rejectionStartedAt;
    const owner = await createVerifiedSession(runtime, {
      email: 're-rejection-owner@example.com',
      username: 're_rejection_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 're-rejection-moderator@example.com',
      username: 're_reject_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Original rejection deadline',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => moderationNow,
      ),
    });

    await request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);
    moderationNow = new Date(rejectionStartedAt.getTime() + 6 * 24 * HOUR_MS);
    await request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'rejected',
      publishedAt: null,
      rejectedAt: rejectionStartedAt,
      visibility: 'unlisted',
    });

    const observedAt = new Date(rejectionStartedAt.getTime() + 7 * 24 * HOUR_MS + 1);
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      { now: () => observedAt },
    );

    await expect(
      controlledVideosService.deleteExpiredRejectedVideos({
        observedAt,
        rejectedBefore: new Date(observedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: video.video.id },
      }),
    ).resolves.toBeNull();
  });

  test('serializes opposing moderation decisions into one canonical final state', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const decisionAt = new Date('2026-03-10T00:00:00.000Z');
    const owner = await createVerifiedSession(runtime, {
      email: 'opposing-decisions-owner@example.com',
      username: 'opposing_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'opposing-decisions-moderator@example.com',
      username: 'opposing_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Opposing decisions',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => decisionAt,
      ),
    });
    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "videos"
          WHERE "id" = CAST(${video.video.id} AS UUID)
          FOR UPDATE
        `;
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      {
        timeout: 15_000,
      },
    );

    await Promise.race([
      gateAcquired.promise,
      delay(5_000).then(() => {
        throw new Error('Moderation decision gate could not be acquired');
      }),
    ]);
    const approvalPromise = request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200)
      .then((response) => response);
    const rejectionPromise = request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200)
      .then((response) => response);

    try {
      await waitForBlockedVideoQueries(runtime.prisma, 2);
    } finally {
      releaseGate.resolve();
      await gateTransaction;
      await gatePrisma.$disconnect();
    }

    const [approvalResponse, rejectionResponse] = await Promise.all([
      approvalPromise,
      rejectionPromise,
    ]);

    expect(approvalResponse.body.video).toMatchObject({
      moderationStatus: 'approved',
      publishedAt: decisionAt.toISOString(),
      rejectedAt: null,
      visibility: 'public',
    });
    expect(rejectionResponse.body.video).toMatchObject({
      moderationStatus: 'rejected',
      rejectedAt: decisionAt.toISOString(),
      visibility: 'unlisted',
    });
    const finalState = await runtime.prisma.video.findUniqueOrThrow({
      where: { id: video.video.id },
      select: {
        moderationStatus: true,
        publishedAt: true,
        rejectedAt: true,
        visibility: true,
      },
    });

    if (finalState.moderationStatus === 'approved') {
      expect(finalState).toEqual({
        moderationStatus: 'approved',
        publishedAt: decisionAt,
        rejectedAt: null,
        visibility: 'public',
      });
    } else {
      expect(finalState).toEqual({
        moderationStatus: 'rejected',
        publishedAt: decisionAt,
        rejectedAt: decisionAt,
        visibility: 'unlisted',
      });
    }
  });

  test('serializes maintenance and approval in both row-lock acquisition orders', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const cleanupNow = new Date('2026-03-20T00:00:00.000Z');
    const rejectedAt = new Date(cleanupNow.getTime() - 8 * 24 * HOUR_MS);
    const owner = await createVerifiedSession(runtime, {
      email: 'maintenance-approval-owner@example.com',
      username: 'maintenance_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'maintenance-approval-moderator@example.com',
      username: 'maintenance_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => cleanupNow,
      ),
    });

    const runInterleaving = async (maintenanceFirst: boolean) => {
      const video = await runtime?.videosService.createVideo({
        userId: owner.userId,
        title: maintenanceFirst ? 'Maintenance wins row lock' : 'Approval wins row lock',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });

      if (!video || !runtime) {
        throw new Error('Integration runtime disappeared during moderation race setup');
      }

      await runtime.prisma.video.update({
        where: { id: video.video.id },
        data: {
          moderationStatus: 'rejected',
          rejectedAt,
        },
      });
      const maintenancePrisma = createPrismaClient(runtime.databaseUrl);
      const maintenanceExternalResources = createExternalResourceReconciler({
        prisma: maintenancePrisma,
        objectStorage: runtime.videoObjectStorage,
        clock: { now: () => cleanupNow },
        logger: testLogger,
      });
      const maintenanceVideosService = createIntegrationVideosService(
        maintenancePrisma,
        runtime.videoObjectStorage,
        maintenanceExternalResources,
        { now: () => cleanupNow },
      );
      const gatePrisma = createPrismaClient(runtime.databaseUrl);
      const gateAcquired = Promise.withResolvers<void>();
      const releaseGate = Promise.withResolvers<void>();
      const gateTransaction = gatePrisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "videos"
            WHERE "id" = CAST(${video.video.id} AS UUID)
            FOR UPDATE
          `;
          gateAcquired.resolve();
          await releaseGate.promise;
        },
        {
          timeout: 15_000,
        },
      );

      await Promise.race([
        gateAcquired.promise,
        delay(5_000).then(() => {
          throw new Error('Maintenance/approval gate could not be acquired');
        }),
      ]);
      const startApproval = () =>
        request(app)
          .post(`/moderation/videos/${video.video.id}/moderation`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`)
          .send({ decision: 'approved' })
          .then((response) => response);
      const startMaintenance = () =>
        maintenanceVideosService.deleteExpiredRejectedVideos({
          observedAt: cleanupNow,
          rejectedBefore: new Date(cleanupNow.getTime() - 7 * 24 * HOUR_MS),
        });
      let approvalPromise: ReturnType<typeof startApproval>;
      let maintenancePromise: ReturnType<typeof startMaintenance>;

      try {
        if (maintenanceFirst) {
          maintenancePromise = startMaintenance();
          await waitForBlockedVideoQueries(runtime.prisma, 1);
          approvalPromise = startApproval();
        } else {
          approvalPromise = startApproval();
          await waitForBlockedVideoQueries(runtime.prisma, 1);
          maintenancePromise = startMaintenance();
        }

        await waitForBlockedVideoQueries(runtime.prisma, 2);
      } finally {
        releaseGate.resolve();
        await gateTransaction;
        await gatePrisma.$disconnect();
      }

      try {
        const [approvalResponse, maintenanceResult] = await Promise.all([
          approvalPromise,
          maintenancePromise,
        ]);

        return {
          approvalResponse,
          maintenanceResult,
          videoId: video.video.id,
        };
      } finally {
        await maintenancePrisma.$disconnect();
      }
    };

    const approvalWins = await runInterleaving(false);

    expect(approvalWins.approvalResponse.status).toBe(200);
    expect(approvalWins.maintenanceResult).toEqual({
      rejectedVideosDeleted: 0,
      rejectedVideoTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approvalWins.videoId },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: cleanupNow,
      rejectedAt: null,
      visibility: 'public',
    });

    const maintenanceWins = await runInterleaving(true);

    expect(maintenanceWins.maintenanceResult).toEqual({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 0,
    });
    expect(maintenanceWins.approvalResponse.status).toBe(404);
    expect(maintenanceWins.approvalResponse.body).toEqual({
      error: 'NotFound',
      message: 'Video not found',
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: maintenanceWins.videoId },
      }),
    ).resolves.toBeNull();
  });

  test('purges only still-rejected videos after seven days and preserves absence targets', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rejected-cleanup-owner@example.com',
      username: 'rejected_cleanup',
    });
    const rejectedAt = new Date();
    const observedAt = new Date(rejectedAt.getTime() + 8 * 24 * HOUR_MS);
    const purged = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected video to purge',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('rejected source bytes'),
      userId: owner.userId,
      videoId: purged.video.id,
      thumbnails: [await createPng(640, 360)],
    });
    const transcodeJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: purged.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const generation = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('rejected generation segment'),
      sourceUploadSessionId: source.uploadSession.id,
      state: 'active',
      transcodeJobId: transcodeJob.id,
      userId: owner.userId,
      videoId: purged.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generation.generationId,
      manifest: generation.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: purged.video.id,
    });
    await runtime.prisma.video.update({
      where: { id: purged.video.id },
      data: {
        activeArtifactGenerationId: generation.generationId,
        hlsMasterObjectKey: generation.manifest.master.objectKey,
        thumbnailObjectKey: generation.manifest.thumbnail.objectKey,
        moderationStatus: 'rejected',
        processingStatus: 'ready',
        rejectedAt,
      },
    });

    const reapproved = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected then approved',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    await runtime.prisma.video.update({
      where: { id: reapproved.video.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt,
      },
    });
    await runtime.adminService.moderateVideo({
      videoId: reapproved.video.id,
      decision: 'approved',
    });

    let cleanupNow = observedAt;
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => cleanupNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      controlledExternalResources,
      { now: () => cleanupNow },
    );
    const cleanup = createMaintenanceCleanupJob({
      authService: runtime.authService,
      videosService: controlledVideosService,
      clock: { now: () => cleanupNow },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 30 * 24 * HOUR_MS,
      },
      logger: testLogger,
    });
    const cleanupResult = await cleanup.runOnce();

    expect(cleanupResult.failedSteps).toEqual([]);
    expect(cleanupResult.summary).toMatchObject({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 4,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: purged.video.id },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: reapproved.video.id },
        select: {
          moderationStatus: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      rejectedAt: null,
      visibility: 'public',
    });
    const retainedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        videoId: purged.video.id,
      },
      select: {
        bucket: true,
        goal: true,
        role: true,
        selector: true,
        selectorKind: true,
        state: true,
      },
      orderBy: { role: 'asc' },
    });

    expect(retainedTargets).toHaveLength(4);
    expect(retainedTargets.map(({ role }) => role).sort()).toEqual([
      'hls_artifacts',
      'source',
      'source_thumbnail',
      'thumbnail_prefix',
    ]);
    expect(retainedTargets).toEqual(
      expect.arrayContaining([expect.objectContaining({ goal: 'absent', state: 'quiescing' })]),
    );
    expect(
      retainedTargets.every(({ goal, state }) => goal === 'absent' && state === 'quiescing'),
    ).toBe(true);
    await expect(
      runtime.prisma.videoUploadSession.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.videoTranscodeJob.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.videoArtifactGeneration.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);

    cleanupNow = new Date(observedAt.getTime() + HOUR_MS + 1);
    await expect(
      controlledExternalResources.reconcileDue({
        roles: ['source', 'source_thumbnail', 'hls_artifacts', 'thumbnail_prefix'],
        limit: 10,
      }),
    ).resolves.toEqual({
      claimed: 4,
      confirmed: 4,
      redirectedAbsent: 0,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          videoId: purged.video.id,
        },
        select: {
          state: true,
        },
      }),
    ).resolves.toEqual([
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
    ]);

    for (const target of retainedTargets) {
      if (target.selectorKind === 'exact') {
        await expect(
          runtime.videoObjectStorage.headObject({
            bucket: target.bucket,
            objectKey: target.selector,
          }),
        ).resolves.toBeNull();
      } else {
        await expect(
          runtime.videoObjectStorage.listObjects({
            bucket: target.bucket,
            prefix: target.selector,
            limit: 1,
          }),
        ).resolves.toMatchObject({
          objects: [],
        });
      }
    }
  });
});
