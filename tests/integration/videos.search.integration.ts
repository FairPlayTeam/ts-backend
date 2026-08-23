import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  searchPublicCreators,
  type PublicCreatorSearchReader,
  type PublicCreatorSearchTransactionOptions,
  type PublicCreatorSearchTransactionRunner,
} from '../../src/services/videos/publicCreatorSearch.js';
import { createVerifiedSession } from './support/fixtures.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const createCreatorSearchReadBarrierRunner = (
  runtime: TestRuntime,
  afterExactMatchRead: () => Promise<void>,
): PublicCreatorSearchTransactionRunner => ({
  run: <T>(
    callback: (reader: PublicCreatorSearchReader) => Promise<T>,
    options: PublicCreatorSearchTransactionOptions,
  ): Promise<T> =>
    runtime.prisma.$transaction(async (tx) => {
      const transactionReader: Pick<Prisma.TransactionClient, 'user'> = tx;
      const reader: PublicCreatorSearchReader = {
        findExact: async (args) => {
          const exactMatch = await transactionReader.user.findFirst(args);
          await afterExactMatchRead();

          return exactMatch;
        },
        findPartial: (args) => transactionReader.user.findMany(args),
      };

      return callback(reader);
    }, options),
});

describe('videos search integration', () => {
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

  test('retries public-id collisions and paginates owner videos on PostgreSQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-metadata@example.com',
      username: 'video_metadata',
    });
    const service = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      {
        publicIds: ['FixedId01_', 'FixedId01_', 'FixedId02_'],
      },
    );
    const createInput = {
      userId: owner.userId,
      description: null,
      tags: [],
      license: 'all_rights_reserved' as const,
      visibility: 'public' as const,
      allowComments: true,
    };
    const first = await service.createVideo({
      ...createInput,
      title: 'First video',
    });
    const second = await service.createVideo({
      ...createInput,
      title: 'Second video',
    });

    expect(first.video.publicId).toBe('FixedId01_');
    expect(first.video.visibility).toBe('unlisted');
    expect(second.video.publicId).toBe('FixedId02_');

    const firstPage = await service.listMyVideos({
      userId: owner.userId,
      limit: 1,
    });

    expect(firstPage.videos).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.listMyVideos({
      userId: owner.userId,
      limit: 1,
      ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
    });

    expect(secondPage.videos).toHaveLength(1);
    expect(secondPage.videos[0]?.id).not.toBe(firstPage.videos[0]?.id);
    expect(secondPage.total).toBe(2);
  });

  test('searches only public approved ready videos without leaking hidden matches', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const app = await createIntegrationApp(activeRuntime);
    const owner = await createVerifiedSession(runtime, {
      email: 'public-video-search@example.com',
      username: 'public_search_owner',
    });
    const createSearchVideo = async ({
      createdAt,
      description = null,
      moderationStatus,
      processingStatus,
      tags = ['catalog-metadata-tag'],
      title,
      visibility,
    }: {
      createdAt?: Date;
      description?: string | null;
      moderationStatus: 'pending' | 'approved' | 'rejected';
      processingStatus: 'draft' | 'ready';
      tags?: string[];
      title: string;
      visibility: 'public' | 'unlisted';
    }) => {
      const result = await activeRuntime.videosService.createVideo({
        userId: owner.userId,
        title,
        description,
        tags,
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });

      await activeRuntime.prisma.video.update({
        where: { id: result.video.id },
        data: {
          moderationStatus,
          processingStatus,
          ...(processingStatus === 'ready' ? { durationSeconds: 19 } : {}),
          visibility,
          publishedAt:
            moderationStatus === 'approved' ? new Date('2026-04-01T00:00:00.000Z') : null,
          ...(createdAt === undefined ? {} : { createdAt }),
        },
      });

      return result.video;
    };

    await Promise.all([
      createSearchVideo({
        title: 'Hidden scope needle unlisted',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        tags: ['hidden-tag-only'],
        visibility: 'unlisted',
      }),
      createSearchVideo({
        title: 'Hidden scope needle pending',
        moderationStatus: 'pending',
        processingStatus: 'ready',
        visibility: 'public',
      }),
      createSearchVideo({
        title: 'Hidden scope needle rejected',
        moderationStatus: 'rejected',
        processingStatus: 'ready',
        visibility: 'public',
      }),
      createSearchVideo({
        title: 'Hidden scope needle unfinished',
        moderationStatus: 'approved',
        processingStatus: 'draft',
        visibility: 'public',
      }),
    ]);

    const hiddenOnly = await request(app)
      .get('/videos/search')
      .query({ search: 'hidden scope needle' })
      .expect(200);
    const absentEverywhere = await request(app)
      .get('/videos/search')
      .query({ search: 'term absent from every video' })
      .expect(200);
    const hiddenTagOnly = await request(app)
      .get('/videos/search')
      .query({ search: 'hidden-tag-only' })
      .expect(200);
    const emptySearchResponse = {
      videos: [],
      creators: [],
      total: 0,
      nextCursor: null,
    };

    expect(hiddenOnly.headers['cache-control']).toBe('no-store');
    expect(absentEverywhere.headers['cache-control']).toBe('no-store');
    expect(hiddenOnly.body).toEqual(emptySearchResponse);
    expect(hiddenTagOnly.body).toEqual(emptySearchResponse);
    expect(absentEverywhere.body).toEqual(emptySearchResponse);
    expect(hiddenOnly.body).toEqual(absentEverywhere.body);
    expect(hiddenTagOnly.body).toEqual(absentEverywhere.body);

    const publicTagVideo = await createSearchVideo({
      title: 'Title unrelated to its searchable tag',
      moderationStatus: 'approved',
      processingStatus: 'ready',
      tags: ['discoverable-tag'],
      visibility: 'public',
    });
    const tagOnlySearch = await request(app)
      .get('/videos/search')
      .query({ search: 'discoverable-tag' })
      .expect(200);
    expect(tagOnlySearch.body).toEqual({
      videos: [
        expect.objectContaining({
          publicId: publicTagVideo.publicId,
          tags: ['discoverable-tag'],
        }),
      ],
      creators: [],
      total: 1,
      nextCursor: null,
    });

    const publicDates = [
      new Date('2026-04-01T00:00:00.000Z'),
      new Date('2026-04-02T00:00:00.000Z'),
      new Date('2026-04-03T00:00:00.000Z'),
    ] as const;
    const publicVideos = await Promise.all([
      createSearchVideo({
        title: 'Catalog needle oldest',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        visibility: 'public',
        createdAt: publicDates[0],
      }),
      createSearchVideo({
        title: 'Middle public result',
        description: 'The catalog needle is in this description',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        visibility: 'public',
        createdAt: publicDates[1],
      }),
      createSearchVideo({
        title: 'Catalog needle newest',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        visibility: 'public',
        createdAt: publicDates[2],
      }),
    ]);

    const firstPage = await request(app)
      .get('/videos/search')
      .query({ search: 'CATALOG NEEDLE', sort: 'oldest', limit: 2 })
      .expect(200);
    expect(firstPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Catalog needle oldest',
      'Middle public result',
    ]);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.nextCursor).toEqual({
      createdAt: publicDates[1]?.toISOString(),
      publicId: publicVideos[1]?.publicId,
    });
    expect(firstPage.body.videos[0]).toEqual({
      publicId: publicVideos[0]?.publicId,
      title: 'Catalog needle oldest',
      description: null,
      tags: ['catalog-metadata-tag'],
      username: 'public_search_owner',
      thumbnailPath: null,
      ratingAverage: 0,
      ratingCount: 0,
      publishedAt: '2026-04-01T00:00:00.000Z',
      createdAt: publicDates[0]?.toISOString(),
    });
    expect(firstPage.body.videos[0]).not.toHaveProperty('id');
    expect(firstPage.body.videos[0]).not.toHaveProperty('thumbnailObjectKey');

    const secondPage = await request(app)
      .get('/videos/search')
      .query({
        search: 'catalog needle',
        sort: 'oldest',
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorPublicId: firstPage.body.nextCursor.publicId,
      })
      .expect(200);
    expect(secondPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Catalog needle newest',
    ]);
    expect(secondPage.body.total).toBe(3);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  test('searches visible creators by username and display name without leaking account fields', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const app = await createIntegrationApp(activeRuntime);
    const createCreator = async ({
      displayName,
      isBanned = false,
      isVerified = true,
      username,
    }: {
      displayName: string | null;
      isBanned?: boolean;
      isVerified?: boolean;
      username: string;
    }) => {
      const account = await createVerifiedSession(activeRuntime, {
        email: `${username}@example.com`,
        username,
      });

      const user = await activeRuntime.prisma.user.update({
        where: { id: account.userId },
        data: {
          displayName,
          isBanned,
          isVerified,
        },
      });

      return {
        ...account,
        createdAt: user.createdAt,
      };
    };

    const exactCreator = await createCreator({ username: 'needle', displayName: 'Exact creator' });
    const usernameCreator = await createCreator({ username: 'alpha_needle', displayName: null });
    const displayNameCreator = await createCreator({
      username: 'display_match',
      displayName: 'Needle display match',
    });
    await createCreator({ username: 'banned_needle', displayName: 'Banned match', isBanned: true });
    await createCreator({
      username: 'unverified_needle',
      displayName: 'Unverified match',
      isVerified: false,
    });
    const percentCreator = await createCreator({
      username: 'percent_creator',
      displayName: 'Budget 50% creator',
    });
    await createCreator({ username: 'nonliteral_creator', displayName: 'Budget 500 creator' });
    const follower = await createCreator({ username: 'search_follower', displayName: null });

    await activeRuntime.prisma.userFollow.create({
      data: {
        followerId: follower.userId,
        followingId: exactCreator.userId,
      },
    });
    const publicVideo = await activeRuntime.videosService.createVideo({
      userId: exactCreator.userId,
      title: 'Unrelated public creator video',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    await activeRuntime.prisma.video.update({
      where: { id: publicVideo.video.id },
      data: {
        visibility: 'public',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        durationSeconds: 19,
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    await activeRuntime.videosService.createVideo({
      userId: exactCreator.userId,
      title: 'Hidden creator draft',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });

    const creatorSearch = await request(app)
      .get('/videos/search')
      .query({ search: 'NEEDLE' })
      .expect(200);

    expect(creatorSearch.body).toEqual({
      videos: [],
      creators: [
        {
          username: 'needle',
          displayName: 'Exact creator',
          avatarUrl: null,
          followerCount: 1,
          videoCount: 1,
          createdAt: exactCreator.createdAt.toISOString(),
        },
        {
          username: 'alpha_needle',
          displayName: null,
          avatarUrl: null,
          followerCount: 0,
          videoCount: 0,
          createdAt: usernameCreator.createdAt.toISOString(),
        },
        {
          username: 'display_match',
          displayName: 'Needle display match',
          avatarUrl: null,
          followerCount: 0,
          videoCount: 0,
          createdAt: displayNameCreator.createdAt.toISOString(),
        },
      ],
      total: 0,
      nextCursor: null,
    });
    for (const creator of creatorSearch.body.creators) {
      expect(Object.keys(creator).sort()).toEqual([
        'avatarUrl',
        'createdAt',
        'displayName',
        'followerCount',
        'username',
        'videoCount',
      ]);
      expect(creator).not.toHaveProperty('id');
      expect(creator).not.toHaveProperty('email');
      expect(creator).not.toHaveProperty('role');
      expect(creator).not.toHaveProperty('isBanned');
      expect(creator).not.toHaveProperty('isVerified');
    }

    for (const hiddenExactUsername of ['banned_needle', 'unverified_needle']) {
      const hiddenExactSearch = await request(app)
        .get('/videos/search')
        .query({ search: hiddenExactUsername })
        .expect(200);
      expect(hiddenExactSearch.body.creators).toEqual([]);
    }

    const literalWildcardSearch = await request(app)
      .get('/videos/search')
      .query({ search: '50%' })
      .expect(200);
    expect(literalWildcardSearch.body.creators).toEqual([
      {
        username: 'percent_creator',
        displayName: 'Budget 50% creator',
        avatarUrl: null,
        followerCount: 0,
        videoCount: 0,
        createdAt: percentCreator.createdAt.toISOString(),
      },
    ]);
  });

  test('reads exact and partial creator matches from one RepeatableRead snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    await createVerifiedSession(activeRuntime, {
      email: 'creator-snapshot-exact@example.com',
      username: 'creator_snapshot',
    });
    const partialCreator = await createVerifiedSession(activeRuntime, {
      email: 'creator-snapshot-partial@example.com',
      username: 'creator_snapshot_alt',
    });
    const exactMatchRead = Promise.withResolvers<void>();
    const releaseExactMatchRead = Promise.withResolvers<void>();
    const transactionRunner = createCreatorSearchReadBarrierRunner(activeRuntime, async () => {
      exactMatchRead.resolve();
      await releaseExactMatchRead.promise;
    });
    const pendingSearch = searchPublicCreators(transactionRunner, 'creator_snapshot');

    await exactMatchRead.promise;
    try {
      await activeRuntime.prisma.user.update({
        where: { id: partialCreator.userId },
        data: { isBanned: true },
      });
    } finally {
      releaseExactMatchRead.resolve();
    }
    const snapshotSearch = await pendingSearch;

    expect(snapshotSearch.map(({ username }) => username)).toEqual([
      'creator_snapshot',
      'creator_snapshot_alt',
    ]);
    const currentSearch = await activeRuntime.videosService.searchPublicVideos({
      search: 'creator_snapshot',
    });
    expect(currentSearch.creators.map(({ username }) => username)).toEqual(['creator_snapshot']);
  });

  test('rejects NUL search terms before they reach PostgreSQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const moderator = await createVerifiedSession(runtime, {
      email: 'nul-search-moderator@example.com',
      username: 'nul_search_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });

    const publicResponse = await request(app).get('/videos/search?search=%00x').expect(400);
    const moderationResponse = await request(app)
      .get('/moderation/videos?search=%00x')
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(400);

    for (const response of [publicResponse, moderationResponse]) {
      expect(response.body).toMatchObject({
        error: 'ValidationError',
        details: [
          {
            field: 'query.search',
            message: 'Video search must not contain NUL characters',
          },
        ],
      });
    }
  });
});
