import { describe, expect, test } from 'bun:test';
import type { AdminDependencies } from '../src/services/admin/admin.dependencies.js';
import { createAdminService } from '../src/services/admin.service.js';
import type { ListAdminVideosInput } from '../src/services/admin.types.js';

const createdAt = [
  new Date('2026-01-03T00:00:00.000Z'),
  new Date('2026-01-02T00:00:00.000Z'),
  new Date('2026-01-01T00:00:00.000Z'),
] as const;
const videoIds = [
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
] as const;

const records = videoIds.map((id, index) => ({
  id,
  publicId: `AdminVid0${index + 1}_`,
  ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: `Moderation video ${index + 1}`,
  moderationStatus: 'pending' as const,
  processingStatus: 'ready' as const,
  visibility: 'unlisted' as const,
  createdAt: createdAt[index] ?? createdAt[0],
  thumbnailObjectKey:
    index === 0 ? 'owner/video/generations/generation/thumbnail/poster.webp' : null,
  publishedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  owner: {
    username: 'video_owner',
  },
}));

const createDeps = () => {
  const calls: {
    count?: unknown;
    findMany?: unknown;
  } = {};
  const deps = {
    prisma: {
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
      video: {
        findMany: async (args: unknown) => {
          calls.findMany = args;

          return records;
        },
        count: async (args: unknown) => {
          calls.count = args;

          return records.length;
        },
      },
    },
    clock: {
      now: () => new Date('2026-01-04T00:00:00.000Z'),
    },
  } as unknown as AdminDependencies;

  return { calls, deps };
};

describe('admin video service', () => {
  test('combines moderation, processing, and text-search filters', async () => {
    const combinations: Array<{
      input: ListAdminVideosInput;
      where: unknown;
    }> = [
      {
        input: { moderationStatus: 'pending' },
        where: { moderationStatus: 'pending' },
      },
      {
        input: { processingStatus: 'processing' },
        where: { processingStatus: 'processing' },
      },
      {
        input: {
          moderationStatus: 'rejected',
          processingStatus: 'failed',
          search: 'failed upload',
        },
        where: {
          AND: [
            {
              moderationStatus: 'rejected',
              processingStatus: 'failed',
            },
            {
              OR: [
                { title: { contains: 'failed upload', mode: 'insensitive' } },
                { description: { contains: 'failed upload', mode: 'insensitive' } },
                { tags: { has: 'failed upload' } },
              ],
            },
          ],
        },
      },
    ];

    for (const { input, where } of combinations) {
      const { calls, deps } = createDeps();
      const service = createAdminService(deps);

      await service.listVideos(input);

      expect(calls.findMany).toEqual(
        expect.objectContaining({
          where,
        }),
      );
      expect(calls.count).toEqual({ where });
    }
  });

  test('searches titles, descriptions, and exact tags without adding status filters', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);
    const where = {
      OR: [
        { title: { contains: 'catalog phrase', mode: 'insensitive' } },
        { description: { contains: 'catalog phrase', mode: 'insensitive' } },
        { tags: { has: 'catalog phrase' } },
      ],
    };

    await expect(service.listVideos({ search: 'catalog phrase' })).resolves.toBeDefined();
    expect(calls.findMany).toEqual(
      expect.objectContaining({
        where,
      }),
    );
    expect(calls.count).toEqual({ where });
  });

  test('treats an empty normalized search as no filter', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await service.listVideos({ search: '   ' });

    expect(calls.findMany).toEqual(expect.objectContaining({ where: {} }));
    expect(calls.count).toEqual({ where: {} });
  });

  test('sorts newest by default and reverses both ordering and cursor comparison for oldest', async () => {
    const cursor = {
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      id: videoIds[1],
    };
    const newest = createDeps();
    const oldest = createDeps();

    await createAdminService(newest.deps).listVideos({ cursor, limit: 2 });
    await createAdminService(oldest.deps).listVideos({ cursor, limit: 2, sort: 'oldest' });

    expect(newest.calls.findMany).toEqual(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        where: {
          AND: [
            {},
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        },
      }),
    );
    expect(oldest.calls.findMany).toEqual(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 3,
        where: {
          AND: [
            {},
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            },
          ],
        },
      }),
    );
  });

  test('returns the same composite next-cursor shape as the owner video list', async () => {
    const { deps } = createDeps();
    const service = createAdminService(deps);

    await expect(service.listVideos({ limit: 2 })).resolves.toEqual(
      expect.objectContaining({
        total: 3,
        nextCursor: {
          createdAt: createdAt[1],
          id: videoIds[1],
        },
        videos: [
          expect.objectContaining({ id: videoIds[0], username: 'video_owner' }),
          expect.objectContaining({ id: videoIds[1], username: 'video_owner' }),
        ],
      }),
    );
  });

  test('maps persisted thumbnail presence to an opaque relative path without exposing the key', async () => {
    const { deps } = createDeps();
    const result = await createAdminService(deps).listVideos({ limit: 1 });

    expect(result.videos[0]).toMatchObject({
      publicId: 'AdminVid01_',
      thumbnailPath: '/videos/AdminVid01_/thumbnail',
    });
    expect(result.videos[0]).not.toHaveProperty('thumbnailObjectKey');
  });
});
