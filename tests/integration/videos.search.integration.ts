import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createVerifiedSession } from './support/fixtures.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

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
      runtime.externalResources,
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
    const app = await createIntegrationApp(runtime);
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
