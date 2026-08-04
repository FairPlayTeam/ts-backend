import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import {
  createIntegrationApp,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const waitForBlockedQueriesMatching = async (
  prisma: PrismaClient,
  expectedCount: number,
  queryFragment: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity] = await prisma.$queryRaw<Array<{ blockedCount: number }>>`
      SELECT count(*)::int AS "blockedCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${queryFragment}%`}
    `;

    if ((activity?.blockedCount ?? 0) >= expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(
    `Timed out waiting for ${expectedCount} blocked queries matching ${queryFragment}`,
  );
};

const waitForBlockedRatingQueries = (prisma: PrismaClient, expectedCount: number): Promise<void> =>
  waitForBlockedQueriesMatching(prisma, expectedCount, '"rating_sum"');

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
    visibility: 'unlisted',
    allowComments: true,
  });

  return runtime.prisma.video.update({
    where: { id: created.video.id },
    data: {
      moderationStatus: data.moderationStatus ?? 'approved',
      processingStatus: data.processingStatus ?? 'ready',
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

    await gateAcquired.promise;
    const firstRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${firstRater.sessionKey}`)
      .send({ value: 5 })
      .expect(200)
      .then((response) => response);
    const secondRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${secondRater.sessionKey}`)
      .send({ value: 3 })
      .expect(200)
      .then((response) => response);

    try {
      await waitForBlockedRatingQueries(runtime.prisma, 2);
    } finally {
      releaseGate.resolve();
      await gateTransaction;
      await gatePrisma.$disconnect();
    }

    await Promise.all([firstRequest, secondRequest]);
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

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'rating-burst-owner@example.com',
      username: 'rating_burst_owner',
    });
    const raters = [];

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

      await gateAcquired.promise;
      const ratingRequests = raters.map((rater, index) => {
        const value = (index % 5) + 1;

        return request(app)
          .put(`/videos/${video.publicId}/rating`)
          .set('Authorization', `Bearer ${rater.sessionKey}`)
          .send({ value })
          .then((response) => ({ response, value }));
      });

      try {
        // The application Prisma pool bounds the number of simultaneous database queries,
        // while all 32 HTTP requests remain in flight.
        await waitForBlockedRatingQueries(gatePrisma, 8);
      } finally {
        releaseGate.resolve();
        await gateTransaction;
        await gatePrisma.$disconnect();
      }

      const results = await Promise.all(ratingRequests);
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

    await gateAcquired.promise;
    const firstRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 1 })
      .expect(200)
      .then((response) => response);
    const secondRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 5 })
      .expect(200)
      .then((response) => response);

    try {
      await waitForBlockedRatingQueries(runtime.prisma, 2);
    } finally {
      releaseGate.resolve();
      await gateTransaction;
      await gatePrisma.$disconnect();
    }

    await Promise.all([firstRequest, secondRequest]);
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

    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "video_ratings" IN ACCESS EXCLUSIVE MODE');
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      { timeout: 15_000 },
    );

    await gateAcquired.promise;
    const updateRequest = request(app)
      .put(`/videos/${video.publicId}/rating`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .send({ value: 5 })
      .then((response) => response);
    await waitForBlockedQueriesMatching(runtime.prisma, 1, 'video_ratings');
    const readRequest = request(app)
      .get(`/videos/${video.publicId}/rating/me`)
      .set('Authorization', `Bearer ${rater.sessionKey}`)
      .then((response) => response);

    try {
      await waitForBlockedQueriesMatching(runtime.prisma, 2, 'video_ratings');
    } finally {
      releaseGate.resolve();
      await gateTransaction;
      await gatePrisma.$disconnect();
    }

    const [updateResponse, readResponse] = await Promise.all([updateRequest, readRequest]);
    expect(updateResponse.status).toBe(200);
    expect(readResponse.status).toBe(200);
    expect([
      { ratingAverage: 1, ratingCount: 1, userRating: 1 },
      { ratingAverage: 5, ratingCount: 1, userRating: 5 },
    ]).toContainEqual(readResponse.body);
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

    await sessionValidated.promise;

    try {
      await runtime.authService.deleteAccount({
        userId: deletedRater.userId,
        currentPassword: INITIAL_PASSWORD,
      });
    } finally {
      releaseRating.resolve();
    }

    const response = await ratingRequest;
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

  test('deletes 2,000 rating contributions with one bounded transaction', async () => {
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
    const ratingCount = 2_000;

    await runtime.prisma.video.createMany({
      data: Array.from({ length: ratingCount }, (_, index) => ({
        ownerId: owner.userId,
        publicId: `RatingVolume${String(index).padStart(4, '0')}`,
        title: `Rating volume ${index}`,
        visibility: 'public' as const,
        moderationStatus: 'approved' as const,
        processingStatus: 'ready' as const,
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

    const startedAt = performance.now();
    await runtime.authService.deleteAccount({
      userId: deletedRater.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    const durationMs = performance.now() - startedAt;

    expect(videos).toHaveLength(ratingCount);
    expect(durationMs).toBeLessThan(5_000);
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
