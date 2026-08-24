import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { recordVideoView } from '../../src/services/videos/videoViews.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import { createPlayableVideo } from './support/playableVideo.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

type ViewWriterHarness = {
  app: Awaited<ReturnType<typeof createIntegrationApp>>;
  arrived: Promise<void>;
  completed: Promise<void>;
  release(): void;
};

const createViewWriterHarness = async (
  runtime: TestRuntime,
  {
    expectedCalls,
    failAfterRelease = false,
    now,
  }: {
    expectedCalls: number;
    failAfterRelease?: boolean;
    now: Date;
  },
): Promise<ViewWriterHarness> => {
  const arrived = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let arrivedCount = 0;
  let completedCount = 0;

  const prisma = new Proxy(runtime.prisma, {
    get(target, property) {
      if (property === '$executeRaw') {
        return async (query: Prisma.Sql): Promise<number> => {
          arrivedCount += 1;
          if (arrivedCount === expectedCalls) {
            arrived.resolve();
          }

          await release.promise;
          try {
            if (failAfterRelease) {
              throw new Error('Injected video-view writer failure');
            }

            return await target.$executeRaw(query);
          } finally {
            completedCount += 1;
            if (completedCount === expectedCalls) {
              completed.resolve();
            }
          }
        };
      }

      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
  const videosService = createIntegrationVideosService(
    prisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
    { now: () => now },
  );

  return {
    app: await createIntegrationApp(runtime, { videosService }),
    arrived: arrived.promise,
    completed: completed.promise,
    release: () => release.resolve(),
  };
};

const waitForViewState = async (
  prisma: PrismaClient,
  videoId: string,
  expectedCount: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const [video, facts] = await Promise.all([
      prisma.video.findUniqueOrThrow({
        where: { id: videoId },
        select: { viewCount: true },
      }),
      prisma.videoView.count({ where: { videoId } }),
    ]);

    if (video.viewCount === expectedCount && facts === expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for video ${videoId} to reach ${expectedCount} views`);
};

describe('video views integration', () => {
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

  test('rejects a direct owner call inside INSERT SELECT without relying on the detail service', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-direct-owner@example.com',
      username: 'view_direct_owner',
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Direct owner view guard',
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });

    await expect(
      recordVideoView(runtime.prisma, {
        userId: owner.userId,
        videoId: video.video.id,
        viewedOn: '2026-08-04',
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.prisma.videoView.count({
        where: { userId: owner.userId, videoId: video.video.id },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.video.id },
        select: { viewCount: true },
      }),
    ).resolves.toEqual({ viewCount: 0 });
  });

  test('counts one authenticated non-owner view per UTC day and exposes the previous snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-owner@example.com',
      username: 'view_owner',
    });
    const viewer = await createVerifiedSession(runtime, {
      email: 'view-viewer@example.com',
      username: 'view_viewer',
    });
    const rejectedViewer = await createVerifiedSession(runtime, {
      email: 'view-rejected@example.com',
      username: 'view_rejected',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Daily authenticated views',
      visibility: 'public',
    });
    const dayOne = new Date('2026-08-04T23:30:00.000Z');
    const app = await createIntegrationApp(runtime);

    const [anonymous, own, invalid] = await Promise.all([
      request(app).get(`/videos/${video.publicId}`).expect(200),
      request(app)
        .get(`/videos/${video.publicId}`)
        .set('Authorization', `Bearer ${owner.sessionKey}`)
        .expect(200),
      request(app)
        .get(`/videos/${video.publicId}`)
        .set('Authorization', 'Bearer invalid-session')
        .expect(200),
    ]);
    expect([
      anonymous.body.video.viewCount,
      own.body.video.viewCount,
      invalid.body.video.viewCount,
    ]).toEqual([0, 0, 0]);
    await expect(runtime.prisma.videoView.count({ where: { videoId: video.id } })).resolves.toBe(0);

    const first = await createViewWriterHarness(runtime, { expectedCalls: 1, now: dayOne });
    const firstResponse = await request(first.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${viewer.sessionKey}`)
      .expect(200);
    expect(firstResponse.body.video.viewCount).toBe(0);
    await first.arrived;
    first.release();
    await first.completed;
    await waitForViewState(runtime.prisma, video.id, 1);

    const repeated = await createViewWriterHarness(runtime, { expectedCalls: 1, now: dayOne });
    const repeatedResponse = await request(repeated.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${viewer.sessionKey}`)
      .expect(200);
    expect(repeatedResponse.body.video.viewCount).toBe(1);
    await repeated.arrived;
    repeated.release();
    await repeated.completed;
    await waitForViewState(runtime.prisma, video.id, 1);

    const nextDay = await createViewWriterHarness(runtime, {
      expectedCalls: 1,
      now: new Date('2026-08-05T00:00:00.000Z'),
    });
    const nextDayResponse = await request(nextDay.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${viewer.sessionKey}`)
      .expect(200);
    expect(nextDayResponse.body.video.viewCount).toBe(1);
    await nextDay.arrived;
    nextDay.release();
    await nextDay.completed;
    await waitForViewState(runtime.prisma, video.id, 2);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { moderationStatus: 'rejected', rejectedAt: new Date() },
    });
    const rejected = await createViewWriterHarness(runtime, {
      expectedCalls: 1,
      now: new Date('2026-08-05T12:00:00.000Z'),
    });
    await request(rejected.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${rejectedViewer.sessionKey}`)
      .expect(200);
    await rejected.arrived;
    rejected.release();
    await rejected.completed;
    await waitForViewState(runtime.prisma, video.id, 3);

    const days = await runtime.prisma.videoView.findMany({
      where: { videoId: video.id, userId: viewer.userId },
      orderBy: { viewedOn: 'asc' },
      select: { viewedOn: true },
    });
    expect(days.map(({ viewedOn }) => viewedOn.toISOString().slice(0, 10))).toEqual([
      '2026-08-04',
      '2026-08-05',
    ]);
  });

  test('deduplicates simultaneous same-user views and preserves concurrent distinct viewers', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-race-owner@example.com',
      username: 'view_race_owner',
    });
    const firstViewer = await createVerifiedSession(runtime, {
      email: 'view-race-one@example.com',
      username: 'view_race_one',
    });
    const secondViewer = await createVerifiedSession(runtime, {
      email: 'view-race-two@example.com',
      username: 'view_race_two',
    });
    const sameUserVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Same-user concurrent views',
      visibility: 'public',
    });
    const sameUser = await createViewWriterHarness(runtime, {
      expectedCalls: 2,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });

    await Promise.all([
      request(sameUser.app)
        .get(`/videos/${sameUserVideo.publicId}`)
        .set('Authorization', `Bearer ${firstViewer.sessionKey}`)
        .expect(200),
      request(sameUser.app)
        .get(`/videos/${sameUserVideo.publicId}`)
        .set('Authorization', `Bearer ${firstViewer.sessionKey}`)
        .expect(200),
    ]);
    await sameUser.arrived;
    sameUser.release();
    await sameUser.completed;
    await waitForViewState(runtime.prisma, sameUserVideo.id, 1);

    const distinctVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Distinct concurrent viewers',
      visibility: 'public',
    });
    const distinctUsers = await createViewWriterHarness(runtime, {
      expectedCalls: 2,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    await Promise.all([
      request(distinctUsers.app)
        .get(`/videos/${distinctVideo.publicId}`)
        .set('Authorization', `Bearer ${firstViewer.sessionKey}`)
        .expect(200),
      request(distinctUsers.app)
        .get(`/videos/${distinctVideo.publicId}`)
        .set('Authorization', `Bearer ${secondViewer.sessionKey}`)
        .expect(200),
    ]);
    await distinctUsers.arrived;
    distinctUsers.release();
    await distinctUsers.completed;
    await waitForViewState(runtime.prisma, distinctVideo.id, 2);
  });

  test('returns the detail before a blocked writer and absorbs its eventual failure', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-failure-owner@example.com',
      username: 'view_failure_owner',
    });
    const viewer = await createVerifiedSession(runtime, {
      email: 'view-failure-viewer@example.com',
      username: 'view_failure_viewer',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Best-effort view failure',
      visibility: 'public',
    });
    const harness = await createViewWriterHarness(runtime, {
      expectedCalls: 1,
      failAfterRelease: true,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });
    const responsePromise = request(harness.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${viewer.sessionKey}`)
      .then((response) => response);

    await harness.arrived;
    try {
      const response = await Promise.race([
        responsePromise,
        delay(1_000).then(() => {
          throw new Error('Detail response waited for the best-effort view writer');
        }),
      ]);
      expect(response.status).toBe(200);
      expect(response.body.video.viewCount).toBe(0);
    } finally {
      harness.release();
    }
    await harness.completed;
    await expect(runtime.prisma.videoView.count({ where: { videoId: video.id } })).resolves.toBe(0);
  });

  test('exports personal view days and subtracts every contribution before account cascade', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-delete-owner@example.com',
      username: 'view_delete_owner',
    });
    const deletedViewer = await createVerifiedSession(runtime, {
      email: 'view-delete-viewer@example.com',
      username: 'view_delete_viewer',
    });
    const remainingViewer = await createVerifiedSession(runtime, {
      email: 'view-delete-remaining@example.com',
      username: 'view_del_remain',
    });
    const firstVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'View cleanup one',
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });
    const secondVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'View cleanup two',
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });
    await runtime.prisma.videoView.createMany({
      data: [
        {
          userId: deletedViewer.userId,
          videoId: firstVideo.video.id,
          viewedOn: new Date('2026-08-02T00:00:00.000Z'),
        },
        {
          userId: deletedViewer.userId,
          videoId: firstVideo.video.id,
          viewedOn: new Date('2026-08-03T00:00:00.000Z'),
        },
        {
          userId: deletedViewer.userId,
          videoId: firstVideo.video.id,
          viewedOn: new Date('2026-08-04T00:00:00.000Z'),
        },
        {
          userId: deletedViewer.userId,
          videoId: secondVideo.video.id,
          viewedOn: new Date('2026-08-04T00:00:00.000Z'),
        },
        {
          userId: remainingViewer.userId,
          videoId: firstVideo.video.id,
          viewedOn: new Date('2026-08-04T00:00:00.000Z'),
        },
      ],
    });
    await Promise.all([
      runtime.prisma.video.update({
        where: { id: firstVideo.video.id },
        data: { viewCount: 4 },
      }),
      runtime.prisma.video.update({
        where: { id: secondVideo.video.id },
        data: { viewCount: 1 },
      }),
    ]);

    const app = await createIntegrationApp(runtime);
    const dataExport = await request(app)
      .post('/auth/me/export')
      .set('Authorization', `Bearer ${deletedViewer.sessionKey}`)
      .send({ currentPassword: INITIAL_PASSWORD })
      .expect(200);
    expect(dataExport.body.videoViews).toEqual(
      [
        { videoId: firstVideo.video.id, viewedOn: '2026-08-02' },
        { videoId: firstVideo.video.id, viewedOn: '2026-08-03' },
        { videoId: firstVideo.video.id, viewedOn: '2026-08-04' },
        { videoId: secondVideo.video.id, viewedOn: '2026-08-04' },
      ].sort(
        (left, right) =>
          left.viewedOn.localeCompare(right.viewedOn) || left.videoId.localeCompare(right.videoId),
      ),
    );

    await runtime.authService.deleteAccount({
      userId: deletedViewer.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    await expect(
      runtime.prisma.video.findMany({
        where: { id: { in: [firstVideo.video.id, secondVideo.video.id] } },
        orderBy: { title: 'asc' },
        select: { viewCount: true },
      }),
    ).resolves.toEqual([{ viewCount: 1 }, { viewCount: 0 }]);
    await expect(
      runtime.prisma.videoView.count({ where: { userId: deletedViewer.userId } }),
    ).resolves.toBe(0);
  });

  test('cannot create a view after deferred rejection purge deletes the video before SQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-purge-race-owner@example.com',
      username: 'view_purge_owner',
    });
    const viewer = await createVerifiedSession(runtime, {
      email: 'view-purge-race-viewer@example.com',
      username: 'view_purge_viewer',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Deferred purge view race',
      visibility: 'public',
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: {
        moderationStatus: 'rejected',
        visibility: 'unlisted',
        rejectedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    });
    const observedAt = new Date('2026-08-04T12:00:00.000Z');
    const harness = await createViewWriterHarness(runtime, {
      expectedCalls: 1,
      now: observedAt,
    });

    const detail = await request(harness.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${viewer.sessionKey}`)
      .expect(200);
    expect(detail.body.video.publicId).toBe(video.publicId);
    await harness.arrived;
    try {
      await expect(
        runtime.videosService.deleteExpiredVideosPendingPurge({
          observedAt,
          purgeBefore: new Date('2026-07-28T12:00:00.000Z'),
        }),
      ).resolves.toEqual({
        videosPendingPurgeDeleted: 1,
        videoPendingPurgeTargetsScheduled: expect.any(Number),
      });
      await expect(
        runtime.prisma.video.findUnique({ where: { id: video.id } }),
      ).resolves.toBeNull();
    } finally {
      harness.release();
    }
    await harness.completed;

    await expect(runtime.prisma.video.findUnique({ where: { id: video.id } })).resolves.toBeNull();
    await expect(runtime.prisma.videoView.count({ where: { videoId: video.id } })).resolves.toBe(0);
  });

  test('cannot leave a ghost view when the viewer is deleted after scheduling but before SQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-delete-race-owner@example.com',
      username: 'view_del_race_owner',
    });
    const deletedViewer = await createVerifiedSession(runtime, {
      email: 'view-delete-race-viewer@example.com',
      username: 'view_del_race_viewer',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'View deletion race',
      visibility: 'public',
    });
    const harness = await createViewWriterHarness(runtime, {
      expectedCalls: 1,
      now: new Date('2026-08-04T12:00:00.000Z'),
    });

    await request(harness.app)
      .get(`/videos/${video.publicId}`)
      .set('Authorization', `Bearer ${deletedViewer.sessionKey}`)
      .expect(200);
    await harness.arrived;
    await runtime.authService.deleteAccount({
      userId: deletedViewer.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    harness.release();
    await harness.completed;

    await expect(runtime.prisma.videoView.count({ where: { videoId: video.id } })).resolves.toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { viewCount: true },
      }),
    ).resolves.toEqual({ viewCount: 0 });
  });

  test('enforces a non-negative view aggregate in PostgreSQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'view-constraint-owner@example.com',
      username: 'view_constraint',
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'View count constraint',
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: true,
    });

    await expect(
      runtime.prisma.video.update({
        where: { id: video.video.id },
        data: { viewCount: -1 },
      }),
    ).rejects.toThrow('videos_view_count_nonnegative_check');
  });
});
