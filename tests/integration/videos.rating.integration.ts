import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  createExternalResourceReconciler,
  USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
} from '../../src/services/externalResources.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import {
  createIntegrationApp,
  createIntegrationAuthService,
  createPrismaClient,
  createQueryObservedPrismaClient,
  createVideoReadBarrierService,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';
import { coordinateGatedOperations, coordinateWhilePaused } from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';

const waitForBlockedQueriesMatching = (
  runtime: TestRuntime,
  expectedCount: number,
  queryFragment: string,
  {
    countMode = 'exact',
    observerPrisma = runtime.prisma,
    signal,
    timeoutMs = 5_000,
  }: {
    countMode?: 'at-least' | 'exact';
    observerPrisma?: PrismaClient;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<void> =>
  waitForPostgresLockWaiters(observerPrisma, {
    applicationNames: [runtime.postgresApplicationName],
    countMode,
    expectedCount,
    queryFragments: [queryFragment],
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });

const waitForBlockedRatingQueries = (
  runtime: TestRuntime,
  expectedCount: number,
  options: {
    countMode?: 'at-least' | 'exact';
    observerPrisma?: PrismaClient;
    signal?: AbortSignal;
  } = {},
): Promise<void> => waitForBlockedQueriesMatching(runtime, expectedCount, '"rating_sum"', options);

const expectCheckConstraintViolation = async (
  operation: Promise<unknown>,
  constraintName?: string,
): Promise<void> => {
  try {
    await operation;
  } catch (err) {
    expect(err).toMatchObject({ name: 'DriverAdapterError' });
    expect((err as Error).message).toContain(constraintName ?? 'videos_rating_');
    return;
  }

  throw new Error(
    `Expected PostgreSQL check constraint ${constraintName ?? 'for video ratings'} to reject the update`,
  );
};

const createRatableVideo = async (
  runtime: TestRuntime,
  ownerId: string,
  title: string,
  data: {
    moderationStatus?: 'approved' | 'pending' | 'rejected';
    processingStatus?: 'draft' | 'ready';
    visibility?: 'public' | 'unlisted';
  } = {},
) => {
  const created = await runtime.videosService.createVideo({
    userId: ownerId,
    title,
    description: null,
    tags: [],
    license: 'all_rights_reserved',
    allowComments: true,
  });

  return runtime.prisma.video.update({
    where: { id: created.video.id },
    data: {
      moderationStatus: data.moderationStatus ?? 'approved',
      processingStatus: data.processingStatus ?? 'ready',
      ...(data.processingStatus === 'draft' ? {} : { durationSeconds: 19 }),
      visibility: data.visibility ?? 'public',
    },
  });
};

describe('video ratings integration', () => {
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

  test('creates the first rating and exposes its aggregate and current-user value', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-first-owner@example.com',
      username: 'rating_first_owner',
    });
    const rater = await createVerifiedSession(runtime, {
      email: 'rating-first-rater@example.com',
      username: 'rating_first_rater',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'First rating searchable');

    const initialAggregate = await request(app).get(`/videos/${video.publicId}/rating`).expect(200);
    expect(initialAggregate.body).toEqual({ ratingAverage: 0, ratingCount: 0 });
    await request(app).get(`/videos/${video.publicId}/rating/me`).expect(401);
    await request(app).put(`/videos/${video.publicId}/rating`).send({ value: 5 }).expect(401);
    await request(app)
      .put(`/videos/${video.id}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 5 })
      .expect(400);

    const response = await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 5 })
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      ratingAverage: 5,
      ratingCount: 1,
      userRating: 5,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 5, ratingCount: 1 });
    await expect(
      runtime.prisma.videoRating.findUnique({
        where: { userId_videoId: { userId: rater.userId, videoId: video.id } },
      }),
    ).resolves.toMatchObject({ value: 5 });

    const currentRating = await request(app)
      .get(`/videos/${video.publicId}/rating/me`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .expect(200);
    expect(currentRating.body).toEqual(response.body);

    const publicAggregate = await request(app).get(`/videos/${video.publicId}/rating`).expect(200);
    expect(publicAggregate.body).toEqual({ ratingAverage: 5, ratingCount: 1 });

    const ownerVideos = await request(app)
      .get('/videos/me')
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(200);
    expect(ownerVideos.body.videos).toEqual([
      expect.objectContaining({
        publicId: video.publicId,
        ratingAverage: 5,
        ratingCount: 1,
      }),
    ]);

    const search = await request(app)
      .get('/videos/search')
      .query({ search: 'First rating searchable' })
      .expect(200);
    expect(search.body.videos).toEqual([
      expect.objectContaining({
        publicId: video.publicId,
        ratingAverage: 5,
        ratingCount: 1,
      }),
    ]);

    const dataExport = await request(app)
      .post('/auth/me/export')
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ currentPassword: INITIAL_PASSWORD })
      .expect(200);
    expect(dataExport.body.videoRatings).toEqual([
      {
        videoId: video.id,
        value: 5,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
  });

  test('updates an existing rating by delta without duplicating or incrementing count', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-update-owner@example.com',
      username: 'rating_update_owner',
    });
    const rater = await createVerifiedSession(runtime, {
      email: 'rating-update-rater@example.com',
      username: 'rating_update_rater',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Updated rating');

    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 2 })
      .expect(200);
    const response = await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 4 })
      .expect(200);

    expect(response.body).toEqual({
      ratingAverage: 4,
      ratingCount: 1,
      userRating: 4,
    });
    const preservedUpdatedAt = new Date('2020-01-01T00:00:00.000Z');
    await runtime.prisma.videoRating.update({
      where: { userId_videoId: { userId: rater.userId, videoId: video.id } },
      data: { updatedAt: preservedUpdatedAt },
    });
    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 4 })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 4, ratingCount: 1 });
    await expect(runtime.prisma.videoRating.count({ where: { videoId: video.id } })).resolves.toBe(
      1,
    );
    await expect(
      runtime.prisma.videoRating.findUniqueOrThrow({
        where: { userId_videoId: { userId: rater.userId, videoId: video.id } },
        select: { updatedAt: true },
      }),
    ).resolves.toEqual({ updatedAt: preservedUpdatedAt });
  });

  test('forbids owners from rating their own video without changing the aggregate', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-self-owner@example.com',
      username: 'rating_self_owner',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Self rating forbidden');

    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .send({ value: 5 })
      .expect(403);

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 0, ratingCount: 0 });
    await expect(runtime.prisma.videoRating.count({ where: { videoId: video.id } })).resolves.toBe(
      0,
    );
  });

  test('keeps rejected ratings readable while refusing non-ready reads and both writes', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-hidden-owner@example.com',
      username: 'rating_hidden_owner',
    });
    const rater = await createVerifiedSession(runtime, {
      email: 'rating-hidden-rater@example.com',
      username: 'rating_hidden_rater',
    });
    const nonReady = await createRatableVideo(runtime, owner.userId, 'Rating non ready', {
      processingStatus: 'draft',
    });
    const rejected = await createRatableVideo(runtime, owner.userId, 'Rating rejected', {
      moderationStatus: 'rejected',
      visibility: 'unlisted',
    });

    await request(app)
      .get(`/videos/${nonReady.publicId}/rating`)
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });
    await request(app)
      .get(`/videos/${nonReady.publicId}/rating/me`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .expect(404);
    await request(app)
      .put(`/videos/${nonReady.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 3 })
      .expect(404);

    await request(app)
      .get(`/videos/${rejected.publicId}/rating`)
      .expect(200)
      .expect({ ratingAverage: 0, ratingCount: 0 });
    await request(app)
      .get(`/videos/${rejected.publicId}/rating/me`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .expect(200)
      .expect({ ratingAverage: 0, ratingCount: 0, userRating: null });
    await request(app)
      .put(`/videos/${rejected.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 3 })
      .expect(404)
      .expect({ error: 'NotFound', message: 'Video not found' });

    await expect(runtime.prisma.videoRating.count()).resolves.toBe(0);
  });

  test('serializes simultaneous first ratings from two users without losing an increment', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-concurrent-owner@example.com',
      username: 'rating_race_owner',
    });
    const firstRater = await createVerifiedSession(runtime, {
      email: 'rating-concurrent-one@example.com',
      username: 'rating_race_one',
    });
    const secondRater = await createVerifiedSession(runtime, {
      email: 'rating-concurrent-two@example.com',
      username: 'rating_race_two',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Concurrent first ratings');
    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "videos"
          WHERE "id" = CAST(${video.id} AS UUID)
          FOR UPDATE
        `;
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      { timeout: 15_000 },
    );

    const startFirstRequest = () =>
      request(app)
        .put(`/videos/${video.publicId}/rating`)
        .set('Authorization', `Bearer ${firstRater.sessionKey}`)
        .send({ value: 5 })
        .expect(200)
        .then((response) => response);
    const startSecondRequest = () =>
      request(app)
        .put(`/videos/${video.publicId}/rating`)
        .set('Authorization', `Bearer ${secondRater.sessionKey}`)
        .send({ value: 3 })
        .expect(200)
        .then((response) => response);
    await coordinateGatedOperations({
      cleanup: [() => gatePrisma.$disconnect()],
      gateBarrierDescription: 'the concurrent-first-ratings video-row gate',
      gateOperation: gateTransaction,
      gatePaused: gateAcquired.promise,
      releaseGate: releaseGate.resolve,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const firstRequest = trackOperation(startFirstRequest());
        const secondRequest = trackOperation(startSecondRequest());
        await waitForSignal({
          description: 'both first ratings behind the video-row gate',
          observe: (signal) => waitForBlockedRatingQueries(activeRuntime, 2, { signal }),
        });

        return [firstRequest, secondRequest] as const;
      },
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 8, ratingCount: 2 });
    await expect(runtime.prisma.videoRating.count({ where: { videoId: video.id } })).resolves.toBe(
      2,
    );
  });

  test('handles repeated bursts of 32 concurrent first ratings without returning 500', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-burst-owner@example.com',
      username: 'rating_burst_owner',
    });
    const raters: Array<Awaited<ReturnType<typeof createVerifiedSession>>> = [];

    for (let index = 0; index < 32; index += 1) {
      raters.push(
        await createVerifiedSession(runtime, {
          email: `rating-burst-${index}@example.com`,
          username: `rating_burst_${index}`,
        }),
      );
    }

    const statuses: number[] = [];

    for (let repetition = 0; repetition < 3; repetition += 1) {
      const video = await createRatableVideo(
        runtime,
        owner.userId,
        `Concurrent rating burst ${repetition}`,
      );
      const gatePrisma = createPrismaClient(runtime.databaseUrl);
      const gateAcquired = Promise.withResolvers<void>();
      const releaseGate = Promise.withResolvers<void>();
      const gateTransaction = gatePrisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "videos"
            WHERE "id" = CAST(${video.id} AS UUID)
            FOR UPDATE
          `;
          gateAcquired.resolve();
          await releaseGate.promise;
        },
        { timeout: 30_000 },
      );

      const results = await coordinateGatedOperations({
        cleanup: [() => gatePrisma.$disconnect()],
        gateBarrierDescription: `the rating-burst video-row gate for repetition ${repetition}`,
        gateOperation: gateTransaction,
        gatePaused: gateAcquired.promise,
        releaseGate: releaseGate.resolve,
        runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
          const ratingRequests = raters.map((rater, index) => {
            const value = (index % 5) + 1;

            return trackOperation(
              request(app)
                .put(`/videos/${video.publicId}/rating`)
                .set('Authorization', `Bearer ${rater.sessionKey}`)
                .send({ value })
                .then((response) => ({ response, value })),
            );
          });
          // The application Prisma pool bounds the number of simultaneous database queries,
          // while all 32 HTTP requests remain in flight.
          await waitForSignal({
            description: `eight rating requests behind the repetition ${repetition} gate`,
            observe: (signal) =>
              waitForBlockedRatingQueries(activeRuntime, 8, {
                countMode: 'at-least',
                observerPrisma: gatePrisma,
                signal,
              }),
          });

          return ratingRequests;
        },
      });
      statuses.push(...results.map(({ response }) => response.status));
      const successfulRatings = results.filter(({ response }) => response.status === 200);
      await expect(
        runtime.prisma.video.findUniqueOrThrow({
          where: { id: video.id },
          select: { ratingSum: true, ratingCount: true },
        }),
      ).resolves.toEqual({
        ratingSum: successfulRatings.reduce((sum, { value }) => sum + value, 0),
        ratingCount: successfulRatings.length,
      });
    }

    expect(statuses.every((status) => status === 200 || status === 503)).toBe(true);
  });

  test('serializes two concurrent updates by one user without double-counting', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-double-click-owner@example.com',
      username: 'rating_double_owner',
    });
    const rater = await createVerifiedSession(runtime, {
      email: 'rating-double-click-rater@example.com',
      username: 'rating_double_rater',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Concurrent updates');
    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 3 })
      .expect(200);
    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "videos"
          WHERE "id" = CAST(${video.id} AS UUID)
          FOR UPDATE
        `;
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      { timeout: 15_000 },
    );

    const startFirstUpdate = () =>
      request(app)
        .put(`/videos/${video.publicId}/rating`)
        .set('Authorization', `Bearer ${rater.sessionKey}`)
        .send({ value: 1 })
        .expect(200)
        .then((response) => response);
    const startSecondUpdate = () =>
      request(app)
        .put(`/videos/${video.publicId}/rating`)
        .set('Authorization', `Bearer ${rater.sessionKey}`)
        .send({ value: 5 })
        .expect(200)
        .then((response) => response);
    await coordinateGatedOperations({
      cleanup: [() => gatePrisma.$disconnect()],
      gateBarrierDescription: 'the concurrent-rating-updates video-row gate',
      gateOperation: gateTransaction,
      gatePaused: gateAcquired.promise,
      releaseGate: releaseGate.resolve,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const firstRequest = trackOperation(startFirstUpdate());
        const secondRequest = trackOperation(startSecondUpdate());
        await waitForSignal({
          description: 'both rating updates behind the video-row gate',
          observe: (signal) => waitForBlockedRatingQueries(activeRuntime, 2, { signal }),
        });

        return [firstRequest, secondRequest] as const;
      },
    });
    const [storedVideo, storedRatings] = await Promise.all([
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
      runtime.prisma.videoRating.findMany({
        where: { videoId: video.id },
        select: { value: true },
      }),
    ]);

    expect(storedRatings).toHaveLength(1);
    expect(storedVideo).toEqual({
      ratingSum: storedRatings[0]?.value,
      ratingCount: 1,
    });
  });

  test('returns the aggregate and current-user rating from one coherent read snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-read-owner@example.com',
      username: 'rating_read_owner',
    });
    const rater = await createVerifiedSession(runtime, {
      email: 'rating-read-rater@example.com',
      username: 'rating_read_rater',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Coherent rating read');
    await request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 1 })
      .expect(200);
    const aggregateRead = Promise.withResolvers<void>();
    const releaseRatingRead = Promise.withResolvers<void>();
    const readService = createVideoReadBarrierService(runtime, async () => {
      aggregateRead.resolve();
      await releaseRatingRead.promise;
    });
    const readApp = await createIntegrationApp(runtime, { videosService: readService });
    const readRequest = request(readApp)
      .get(`/videos/${video.publicId}/rating/me`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .then((response) => response);
    const [readResponse, updateResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'the current-rating aggregate read',
      firstOperation: readRequest,
      firstPaused: aggregateRead.promise,
      releaseFirst: releaseRatingRead.resolve,
      runWhilePaused: () =>
        request(app)
          .put(`/videos/${video.publicId}/rating`)
          .set('Authorization', `Bearer ${rater.sessionKey}`)
          .send({ value: 5 })
          .expect(200)
          .then((response) => response),
      whilePausedDescription: 'the committed rating update after the aggregate read',
    });

    expect(updateResponse.body).toEqual({ ratingAverage: 5, ratingCount: 1, userRating: 5 });
    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual({ ratingAverage: 1, ratingCount: 1, userRating: 1 });
  });

  test('returns 404 when the authenticated rater is deleted before the rating write', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rating-deleted-race-owner@example.com',
      username: 'rating_del_owner',
    });
    const deletedRater = await createVerifiedSession(runtime, {
      email: 'rating-deleted-race-rater@example.com',
      username: 'rating_del_rater',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Deleted rater race');
    const sessionValidated = Promise.withResolvers<void>();
    const releaseRating = Promise.withResolvers<void>();
    let shouldPause = true;
    const activeRuntime = runtime;
    const app = await createIntegrationApp({
      ...activeRuntime,
      authService: {
        ...activeRuntime.authService,
        validateSession: async (sessionKey) => {
          const validated = await activeRuntime.authService.validateSession(sessionKey);

          if (shouldPause && validated?.user.id === deletedRater.userId) {
            shouldPause = false;
            sessionValidated.resolve();
            await releaseRating.promise;
          }

          return validated;
        },
      },
    });
    const ratingRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${deletedRater.sessionKey}`)
      .send({ value: 4 })
      .then((response) => response);

    const [response] = await coordinateWhilePaused({
      firstBarrierDescription: 'the deleted-rater session validation',
      firstOperation: ratingRequest,
      firstPaused: sessionValidated.promise,
      releaseFirst: releaseRating.resolve,
      runWhilePaused: () =>
        activeRuntime.authService.deleteAccount({
          userId: deletedRater.userId,
          currentPassword: INITIAL_PASSWORD,
        }),
      whilePausedDescription: 'the rater account deletion before the rating write',
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NotFound', message: 'Video not found' });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 0, ratingCount: 0 });
    await expect(runtime.prisma.videoRating.count({ where: { videoId: video.id } })).resolves.toBe(
      0,
    );
  });

  test('enforces non-negative and internally consistent video rating aggregates in PostgreSQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rating-constraints-owner@example.com',
      username: 'rating_constraints',
    });
    const video = await createRatableVideo(runtime, owner.userId, 'Rating constraints');
    const constraints = await runtime.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT conname AS "name"
      FROM pg_constraint
      WHERE conrelid = 'videos'::regclass
        AND conname IN (
          'videos_rating_sum_nonnegative_check',
          'videos_rating_count_nonnegative_check',
          'videos_rating_sum_minimum_check',
          'videos_rating_sum_count_check'
        )
      ORDER BY conname
    `;
    expect(constraints.map(({ name }) => name)).toEqual([
      'videos_rating_count_nonnegative_check',
      'videos_rating_sum_count_check',
      'videos_rating_sum_minimum_check',
      'videos_rating_sum_nonnegative_check',
    ]);

    await expectCheckConstraintViolation(
      runtime.prisma.video.update({ where: { id: video.id }, data: { ratingSum: -1 } }),
    );
    await expectCheckConstraintViolation(
      runtime.prisma.video.update({ where: { id: video.id }, data: { ratingCount: -1 } }),
    );
    await expectCheckConstraintViolation(
      runtime.prisma.video.update({
        where: { id: video.id },
        data: { ratingSum: 6, ratingCount: 1 },
      }),
      'videos_rating_sum_count_check',
    );
    await expectCheckConstraintViolation(
      runtime.prisma.video.update({ where: { id: video.id }, data: { ratingCount: 1 } }),
      'videos_rating_sum_minimum_check',
    );
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { ratingSum: true, ratingCount: true },
      }),
    ).resolves.toEqual({ ratingSum: 0, ratingCount: 0 });
  });

  test('subtracts every rating contribution when the rater account is deleted', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const firstOwner = await createVerifiedSession(runtime, {
      email: 'rating-delete-owner-one@example.com',
      username: 'rating_delete_one',
    });
    const secondOwner = await createVerifiedSession(runtime, {
      email: 'rating-delete-owner-two@example.com',
      username: 'rating_delete_two',
    });
    const deletedRater = await createVerifiedSession(runtime, {
      email: 'rating-delete-rater@example.com',
      username: 'rating_delete_rater',
    });
    const remainingRater = await createVerifiedSession(runtime, {
      email: 'rating-delete-remaining@example.com',
      username: 'rating_delete_remain',
    });
    const firstVideo = await createRatableVideo(runtime, firstOwner.userId, 'Delete rating one');
    const secondVideo = await createRatableVideo(runtime, secondOwner.userId, 'Delete rating two');

    await runtime.videosService.rateVideo({
      userId: deletedRater.userId,
      publicId: firstVideo.publicId,
      value: 5,
    });
    await runtime.videosService.rateVideo({
      userId: remainingRater.userId,
      publicId: firstVideo.publicId,
      value: 3,
    });
    await runtime.videosService.rateVideo({
      userId: deletedRater.userId,
      publicId: secondVideo.publicId,
      value: 2,
    });

    await runtime.authService.deleteAccount({
      userId: deletedRater.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    const [firstAggregate, secondAggregate, deletedRatings] = await Promise.all([
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: firstVideo.id },
        select: { ratingSum: true, ratingCount: true },
      }),
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: secondVideo.id },
        select: { ratingSum: true, ratingCount: true },
      }),
      runtime.prisma.videoRating.count({ where: { userId: deletedRater.userId } }),
    ]);

    expect(firstAggregate).toEqual({ ratingSum: 3, ratingCount: 1 });
    expect(secondAggregate).toEqual({ ratingSum: 0, ratingCount: 0 });
    expect(deletedRatings).toBe(0);
  });

  test('uses the same bounded SQL statement set to delete one or 2,000 rating contributions', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rating-volume-owner@example.com',
      username: 'rating_volume_owner',
    });
    const deletedRater = await createVerifiedSession(runtime, {
      email: 'rating-volume-rater@example.com',
      username: 'rating_volume_rater',
    });
    const baselineRater = await createVerifiedSession(runtime, {
      email: 'rating-baseline-rater@example.com',
      username: 'rating_base_rater',
    });
    const ratingCount = 2_000;

    await runtime.prisma.video.createMany({
      data: Array.from({ length: ratingCount }, (_, index) => ({
        ownerId: owner.userId,
        publicId: `RatingVolume${String(index).padStart(4, '0')}`,
        title: `Rating volume ${index}`,
        visibility: 'public' as const,
        moderationStatus: 'approved' as const,
        processingStatus: 'ready' as const,
        durationSeconds: 19,
        ratingSum: 3,
        ratingCount: 1,
      })),
    });
    const videos = await runtime.prisma.video.findMany({
      where: {
        ownerId: owner.userId,
        title: { startsWith: 'Rating volume ' },
      },
      select: { id: true },
    });
    await runtime.prisma.videoRating.createMany({
      data: videos.map(({ id: videoId }) => ({
        userId: deletedRater.userId,
        videoId,
        value: 3,
      })),
    });
    const firstVideo = videos[0];

    if (!firstVideo) {
      throw new Error('Expected at least one rating-volume video');
    }

    await runtime.prisma.$transaction([
      runtime.prisma.videoRating.create({
        data: {
          userId: baselineRater.userId,
          videoId: firstVideo.id,
          value: 4,
        },
      }),
      runtime.prisma.video.update({
        where: { id: firstVideo.id },
        data: {
          ratingSum: { increment: 4 },
          ratingCount: { increment: 1 },
        },
      }),
    ]);

    const statements: string[] = [];
    const observedPrisma = createQueryObservedPrismaClient(runtime.databaseUrl, ({ query }) => {
      statements.push(query);
    });
    const observedExternalResources = createExternalResourceReconciler({
      prisma: observedPrisma,
      objectStorage: runtime.objectStorage,
      clock: { now: () => new Date() },
      logger: testLogger,
      allowedRoles: USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
    });
    const deletionService = createIntegrationAuthService(
      observedPrisma,
      runtime.objectStorage,
      runtime.delivered,
      observedExternalResources,
    );
    let baselineStatements: string[];
    let volumeStatements: string[];

    try {
      statements.length = 0;
      await deletionService.deleteAccount({
        userId: baselineRater.userId,
        currentPassword: INITIAL_PASSWORD,
      });
      baselineStatements = [...statements];

      statements.length = 0;
      await deletionService.deleteAccount({
        userId: deletedRater.userId,
        currentPassword: INITIAL_PASSWORD,
      });
      volumeStatements = [...statements];
    } finally {
      await observedPrisma.$disconnect();
    }

    expect(videos).toHaveLength(ratingCount);
    expect(volumeStatements).toEqual(baselineStatements);
    expect(
      volumeStatements.filter(
        (sql) => sql.includes('UPDATE "videos" AS v') && sql.includes('FROM "video_ratings" AS vr'),
      ),
    ).toHaveLength(1);
    await expect(
      runtime.prisma.video.count({
        where: {
          ownerId: owner.userId,
          OR: [{ ratingSum: { not: 0 } }, { ratingCount: { not: 0 } }],
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.videoRating.count({ where: { userId: deletedRater.userId } }),
    ).resolves.toBe(0);
  });
});
