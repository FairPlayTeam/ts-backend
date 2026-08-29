import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { VideosService } from '../../src/services/videos.types.js';
import { createVerifiedSession } from './support/fixtures.js';
import { createPlayableVideo } from './support/playableVideo.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const createCatalogReadBarrierService = (
  runtime: TestRuntime,
  afterRowsRead: () => Promise<void>,
): VideosService => {
  const barrierPrisma = {
    $transaction: async <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<T> =>
      runtime.prisma.$transaction(async (tx) => {
        const barrierTransaction = {
          video: {
            findMany: async (args: unknown) => {
              const videos = await tx.video.findMany(args as never);
              await afterRowsRead();

              return videos;
            },
            count: (args: unknown) => tx.video.count(args as never),
          },
        } as unknown as Prisma.TransactionClient;

        return run(barrierTransaction);
      }, options),
  } as unknown as PrismaClient;

  return createIntegrationVideosService(
    barrierPrisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
  );
};

describe('public video feed integration', () => {
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

  test('lists only eligible cards newest-first with stable pagination and no internal fields', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const owner = await createVerifiedSession(runtime, {
      email: 'feed-owner@example.com',
      username: 'jawed_feed',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { displayName: 'Jawed Karim' },
    });
    const createCatalogVideo = async ({
      createdAt,
      moderationStatus,
      processingStatus,
      title,
      visibility,
    }: {
      createdAt: Date;
      moderationStatus: 'approved' | 'pending' | 'rejected';
      processingStatus: 'draft' | 'ready';
      title: string;
      visibility: 'public' | 'unlisted';
    }) => {
      const created = await activeRuntime.videosService.createVideo({
        userId: owner.userId,
        title,
        description: 'This must never appear in a feed card.',
        tags: ['internal-feed-tag'],
        license: 'cc_by',
        allowComments: true,
      });

      return activeRuntime.prisma.video.update({
        where: { id: created.video.id },
        data: {
          createdAt,
          moderationStatus,
          processingStatus,
          ...(processingStatus === 'ready' ? { durationSeconds: 19 } : {}),
          visibility,
        },
        select: { id: true, publicId: true },
      });
    };
    const dates = [
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-02T00:00:00.000Z'),
      new Date('2026-06-03T00:00:00.000Z'),
    ] as const;
    const [oldest, middle, newest] = await Promise.all([
      createCatalogVideo({
        createdAt: dates[0],
        moderationStatus: 'approved',
        processingStatus: 'ready',
        title: 'Feed oldest',
        visibility: 'public',
      }),
      createCatalogVideo({
        createdAt: dates[1],
        moderationStatus: 'approved',
        processingStatus: 'ready',
        title: 'Feed middle',
        visibility: 'public',
      }),
      createCatalogVideo({
        createdAt: dates[2],
        moderationStatus: 'approved',
        processingStatus: 'ready',
        title: 'Feed newest',
        visibility: 'public',
      }),
    ]);
    await Promise.all([
      createCatalogVideo({
        createdAt: new Date('2026-06-04T00:00:00.000Z'),
        moderationStatus: 'approved',
        processingStatus: 'ready',
        title: 'Hidden unlisted',
        visibility: 'unlisted',
      }),
      createCatalogVideo({
        createdAt: new Date('2026-06-05T00:00:00.000Z'),
        moderationStatus: 'pending',
        processingStatus: 'ready',
        title: 'Hidden pending',
        visibility: 'public',
      }),
      createCatalogVideo({
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
        moderationStatus: 'rejected',
        processingStatus: 'ready',
        title: 'Hidden rejected',
        visibility: 'public',
      }),
      createCatalogVideo({
        createdAt: new Date('2026-06-07T00:00:00.000Z'),
        moderationStatus: 'approved',
        processingStatus: 'draft',
        title: 'Hidden draft',
        visibility: 'public',
      }),
    ]);

    const app = await createIntegrationApp(runtime);
    const firstPage = await request(app).get('/videos').query({ limit: 2 }).expect(200);

    expect(firstPage.headers['cache-control']).toBe('no-store');
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.videos.map(({ publicId }: { publicId: string }) => publicId)).toEqual([
      newest.publicId,
      middle.publicId,
    ]);
    expect(firstPage.body.nextCursor).toEqual({
      createdAt: dates[1]?.toISOString(),
      publicId: middle.publicId,
    });

    const secondPage = await request(app)
      .get('/videos')
      .query({
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorPublicId: firstPage.body.nextCursor.publicId,
      })
      .expect(200);
    expect(secondPage.body).toEqual({
      videos: [
        {
          publicId: oldest.publicId,
          title: 'Feed oldest',
          createdAt: dates[0]?.toISOString(),
          thumbnailPath: null,
          creator: {
            username: 'jawed_feed',
            displayName: 'Jawed Karim',
          },
          viewCount: 0,
          duration: 19,
        },
      ],
      total: 3,
      nextCursor: null,
    });
    expect(Object.keys(firstPage.body.videos[0]).sort()).toEqual(
      [
        'createdAt',
        'creator',
        'duration',
        'publicId',
        'thumbnailPath',
        'title',
        'viewCount',
      ].sort(),
    );
    expect(Object.keys(firstPage.body.videos[0].creator).sort()).toEqual(
      ['displayName', 'username'].sort(),
    );
  });

  test('keeps duration, view count, and opaque thumbnail path coherent with video detail', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'feed-detail-owner@example.com',
      username: 'jawed_detail',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { displayName: 'Jawed Karim' },
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Me at the zoo',
      visibility: 'public',
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { viewCount: 128 },
    });
    const app = await createIntegrationApp(runtime);

    const [feed, detail] = await Promise.all([
      request(app).get('/videos').expect(200),
      request(app).get(`/videos/${video.publicId}`).expect(200),
    ]);
    const card = feed.body.videos.find(
      ({ publicId }: { publicId: string }) => publicId === video.publicId,
    );

    expect(card).toEqual(
      expect.objectContaining({
        publicId: video.publicId,
        thumbnailPath: `/videos/${video.publicId}/thumbnail`,
        viewCount: 128,
        duration: 19,
      }),
    );
    expect({
      thumbnailPath: card.thumbnailPath,
      viewCount: card.viewCount,
      duration: card.duration,
    }).toEqual({
      thumbnailPath: detail.body.video.thumbnailPath,
      viewCount: detail.body.video.viewCount,
      duration: detail.body.video.duration,
    });
  });

  test('keeps cards and total on one snapshot when an owner is deleted between page and count', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const [deletedOwner, retainedOwner] = await Promise.all([
      createVerifiedSession(runtime, {
        email: 'feed-snapshot-deleted-owner@example.com',
        username: 'feed_snap_del',
      }),
      createVerifiedSession(runtime, {
        email: 'feed-snapshot-retained-owner@example.com',
        username: 'feed_snap_keep',
      }),
    ]);
    const [deletedVideo, retainedVideo] = await Promise.all([
      createPlayableVideo(runtime, {
        ownerId: deletedOwner.userId,
        title: 'Deleted owner snapshot card',
        visibility: 'public',
      }),
      createPlayableVideo(runtime, {
        ownerId: retainedOwner.userId,
        title: 'Retained owner snapshot card',
        visibility: 'public',
      }),
    ]);
    const rowsRead = Promise.withResolvers<void>();
    const releaseRows = Promise.withResolvers<void>();
    const barrierService = createCatalogReadBarrierService(runtime, async () => {
      rowsRead.resolve();
      await releaseRows.promise;
    });
    const barrierApp = await createIntegrationApp(runtime, { videosService: barrierService });
    const pendingFeed = request(barrierApp)
      .get('/videos')
      .query({ limit: 100 })
      .then((response) => response);

    await rowsRead.promise;
    try {
      await runtime.prisma.user.delete({ where: { id: deletedOwner.userId } });
    } finally {
      releaseRows.resolve();
    }
    const feed = await pendingFeed;

    expect(feed.status).toBe(200);
    expect(feed.body.total).toBe(2);
    expect(feed.body.videos).toHaveLength(2);
    expect(feed.body.videos.map(({ publicId }: { publicId: string }) => publicId).sort()).toEqual(
      [deletedVideo.publicId, retainedVideo.publicId].sort(),
    );

    const currentFeed = await request(await createIntegrationApp(runtime))
      .get('/videos')
      .expect(200);
    expect(currentFeed.body.total).toBe(1);
    expect(currentFeed.body.videos).toHaveLength(1);
    expect(currentFeed.body.videos[0].publicId).toBe(retainedVideo.publicId);
  });

  test('rejects a ready video without persisted duration at the database boundary', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'feed-duration-constraint@example.com',
      username: 'feed_duration_guard',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Missing ready duration',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });

    await expect(
      runtime.prisma.video.update({
        where: { id: created.video.id },
        data: { processingStatus: 'ready' },
      }),
    ).rejects.toThrow('videos_ready_duration_required_check');
  });
});
