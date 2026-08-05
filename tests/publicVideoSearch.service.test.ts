import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import type { VideosDependencies } from '../src/services/videos/videos.dependencies.js';
import { createVideosService } from '../src/services/videos.service.js';
import type { SearchPublicVideosInput } from '../src/services/videos.types.js';

const createdAt = [
  new Date('2026-01-03T00:00:00.000Z'),
  new Date('2026-01-02T00:00:00.000Z'),
  new Date('2026-01-01T00:00:00.000Z'),
] as const;

const records = createdAt.map((recordCreatedAt, index) => ({
  publicId: `PublicVid0${index + 1}_`,
  title: `Public search video ${index + 1}`,
  description: index === 0 ? 'Launch recap in the description' : null,
  tags: ['public-video-tag'],
  ratingSum: index === 0 ? 9 : 0,
  ratingCount: index === 0 ? 2 : 0,
  thumbnailObjectKey:
    index === 0 ? `owner/video-${index}/generations/generation/thumbnail/poster.webp` : null,
  publishedAt: new Date('2026-01-04T00:00:00.000Z'),
  createdAt: recordCreatedAt,
  owner: {
    username: 'video_owner',
  },
}));

const createDeps = () => {
  const calls: {
    count?: unknown;
    findMany?: unknown;
    countCalls: number;
    findManyCalls: number;
    transactionOptions?: unknown;
  } = {
    countCalls: 0,
    findManyCalls: 0,
  };
  const tx = {
    video: {
      findMany: async (args: unknown) => {
        calls.findMany = args;
        calls.findManyCalls += 1;

        return records;
      },
      count: async (args: unknown) => {
        calls.count = args;
        calls.countCalls += 1;

        return records.length;
      },
    },
  };
  const deps = {
    prisma: {
      $transaction: async (run: (transaction: typeof tx) => Promise<unknown>, options: unknown) => {
        calls.transactionOptions = options;
        return run(tx);
      },
    },
  } as unknown as VideosDependencies;

  return { calls, deps };
};

describe('public video search service', () => {
  test('hard-codes the public scope into both the page and count filters', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);
    const searchFilter = {
      OR: [
        { title: { contains: 'launch recap', mode: 'insensitive' } },
        { description: { contains: 'launch recap', mode: 'insensitive' } },
        { tags: { has: 'launch recap' } },
      ],
    };
    const resultFilter = {
      AND: [
        {
          visibility: 'public',
          moderationStatus: 'approved',
          processingStatus: 'ready',
        },
        searchFilter,
      ],
    };

    const result = await service.searchPublicVideos({ search: 'launch recap' });

    expect(calls.findMany).toEqual(
      expect.objectContaining({
        where: resultFilter,
        orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
        take: 21,
      }),
    );
    expect(calls.count).toEqual({ where: resultFilter });
    expect(calls.transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(result.videos[0]).toEqual({
      publicId: 'PublicVid01_',
      title: 'Public search video 1',
      description: 'Launch recap in the description',
      tags: ['public-video-tag'],
      username: 'video_owner',
      thumbnailPath: '/videos/PublicVid01_/thumbnail',
      ratingAverage: 4.5,
      ratingCount: 2,
      publishedAt: new Date('2026-01-04T00:00:00.000Z'),
      createdAt: createdAt[0],
    });
    expect(result.videos[0]).not.toHaveProperty('id');
    expect(result.videos[0]).not.toHaveProperty('thumbnailObjectKey');
  });

  test('uses the established composite cursor for both sort directions', async () => {
    const cursor = {
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      publicId: records[1]?.publicId ?? 'PublicVid02_',
    };
    const newest = createDeps();
    const oldest = createDeps();

    await createVideosService(newest.deps).searchPublicVideos({
      search: 'video',
      cursor,
      limit: 2,
    });
    await createVideosService(oldest.deps).searchPublicVideos({
      search: 'video',
      cursor,
      limit: 2,
      sort: 'oldest',
    });

    expect(newest.calls.findMany).toEqual(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
        take: 3,
        where: {
          AND: [
            expect.any(Object),
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  publicId: { lt: cursor.publicId },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(oldest.calls.findMany).toEqual(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { publicId: 'asc' }],
        take: 3,
        where: {
          AND: [
            expect.any(Object),
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                {
                  createdAt: cursor.createdAt,
                  publicId: { gt: cursor.publicId },
                },
              ],
            },
          ],
        },
      }),
    );
    await expect(
      createVideosService(createDeps().deps).searchPublicVideos({
        search: 'video',
        limit: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        nextCursor: {
          createdAt: createdAt[1],
          publicId: records[1]?.publicId,
        },
      }),
    );
  });

  test('returns an empty page without querying the database for an empty direct-service search', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);
    const input = { search: '   ' } satisfies SearchPublicVideosInput;

    await expect(service.searchPublicVideos(input)).resolves.toEqual({
      videos: [],
      total: 0,
      nextCursor: null,
    });
    expect(calls.findManyCalls).toBe(0);
    expect(calls.countCalls).toBe(0);
  });
});
