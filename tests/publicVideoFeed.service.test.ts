import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import type { VideosDependencies } from '../src/services/videos/videos.dependencies.js';
import { createVideosService } from '../src/services/videos.service.js';
import { PublicProfileNotFoundError } from '../src/services/profiles.errors.js';

const createdAt = [
  new Date('2026-01-03T00:00:00.000Z'),
  new Date('2026-01-02T00:00:00.000Z'),
  new Date('2026-01-01T00:00:00.000Z'),
] as const;

const records = createdAt.map((recordCreatedAt, index) => ({
  publicId: `PublicVid0${index + 1}_`,
  title: index === 0 ? 'Me at the zoo' : `Public feed video ${index + 1}`,
  description: 'Internal feed description',
  tags: ['internal-feed-tag'],
  thumbnailObjectKey:
    index === 0 ? `owner/video-${index}/generations/generation/thumbnail/poster.webp` : null,
  ratingSum: 9,
  ratingCount: 2,
  viewCount: 128 - index,
  durationSeconds: 19 + index,
  publishedAt: new Date('2026-01-04T00:00:00.000Z'),
  createdAt: recordCreatedAt,
  owner: {
    username: 'jawed',
    displayName: index === 0 ? 'Jawed Karim' : null,
  },
  id: 'internal-video-id',
  ownerId: 'internal-owner-id',
  moderationStatus: 'approved',
  processingStatus: 'ready',
  rejectionReason: 'internal-rejection-reason',
  hlsMasterObjectKey: 'internal-master-key',
  bucket: 'internal-bucket',
  objectKey: 'internal-object-key',
}));

const createDeps = ({ visibleOwner = true }: { visibleOwner?: boolean } = {}) => {
  const calls: {
    count?: unknown;
    findMany?: unknown;
    operationOrder: string[];
    transactionOptions?: unknown;
    userFindFirst?: unknown;
  } = { operationOrder: [] };
  const tx = {
    user: {
      findFirst: async (args: unknown) => {
        calls.operationOrder.push('user.findFirst');
        calls.userFindFirst = args;

        return visibleOwner ? { id: '11111111-1111-4111-8111-111111111111' } : null;
      },
    },
    video: {
      findMany: async (args: unknown) => {
        calls.operationOrder.push('video.findMany');
        calls.findMany = args;
        return records;
      },
      count: async (args: unknown) => {
        calls.operationOrder.push('video.count');
        calls.count = args;
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

describe('public video feed service', () => {
  test('maps an explicit card DTO through the shared chronological public scope', async () => {
    const { calls, deps } = createDeps();

    const result = await createVideosService(deps).listPublicVideos({});

    const publicScope = {
      visibility: 'public',
      moderationStatus: 'approved',
      processingStatus: 'ready',
    };
    expect(calls.findMany).toEqual(
      expect.objectContaining({
        where: publicScope,
        orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
        take: 21,
      }),
    );
    expect(calls.count).toEqual({ where: publicScope });
    expect(calls.transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(result.videos[0]).toEqual({
      publicId: 'PublicVid01_',
      title: 'Me at the zoo',
      createdAt: createdAt[0],
      thumbnailPath: '/videos/PublicVid01_/thumbnail',
      creator: {
        username: 'jawed',
        displayName: 'Jawed Karim',
      },
      viewCount: 128,
      duration: 19,
    });

    for (const forbidden of [
      'id',
      'ownerId',
      'description',
      'tags',
      'ratingSum',
      'ratingCount',
      'moderationStatus',
      'processingStatus',
      'thumbnailObjectKey',
      'hlsMasterObjectKey',
      'rejectionReason',
      'bucket',
      'objectKey',
    ]) {
      expect(result.videos[0]).not.toHaveProperty(forbidden);
    }
  });

  test('uses the same composite cursor and page boundary as public search', async () => {
    const { calls, deps } = createDeps();
    const cursor = {
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
      publicId: 'PublicVid04_',
    };

    const result = await createVideosService(deps).listPublicVideos({ cursor, limit: 2 });

    expect(calls.findMany).toEqual(
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
    expect(result.videos).toHaveLength(2);
    expect(result.nextCursor).toEqual({
      createdAt: createdAt[1],
      publicId: 'PublicVid02_',
    });
  });

  test('filters a creator page by owner and preserves the feed card mapping', async () => {
    const feed = createDeps();
    const creator = createDeps();
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const feedResult = await createVideosService(feed.deps).listPublicVideos({});
    const creatorResult = await createVideosService(creator.deps).listPublicProfileVideos({
      ownerId,
    });
    const publicScope = {
      visibility: 'public',
      moderationStatus: 'approved',
      processingStatus: 'ready',
    };

    expect(creator.calls.findMany).toEqual(
      expect.objectContaining({
        where: { AND: [publicScope, { ownerId }] },
        orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
        take: 21,
      }),
    );
    expect(creator.calls.count).toEqual({
      where: { AND: [publicScope, { ownerId }] },
    });
    expect(creator.calls.transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(creator.calls.userFindFirst).toEqual({
      where: {
        id: ownerId,
        isVerified: true,
        isBanned: false,
      },
      select: { id: true },
    });
    expect(creator.calls.operationOrder).toEqual([
      'user.findFirst',
      'video.findMany',
      'video.count',
    ]);
    expect(creatorResult).toEqual(feedResult);

    for (const forbidden of [
      'id',
      'ownerId',
      'ratingSum',
      'ratingCount',
      'moderationStatus',
      'processingStatus',
      'thumbnailObjectKey',
      'hlsMasterObjectKey',
      'bucket',
      'objectKey',
    ]) {
      expect(creatorResult.videos[0]).not.toHaveProperty(forbidden);
    }
  });

  test('rejects an owner that becomes ineligible before reading any catalog rows', async () => {
    const { calls, deps } = createDeps({ visibleOwner: false });

    await expect(
      createVideosService(deps).listPublicProfileVideos({
        ownerId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(PublicProfileNotFoundError);
    expect(calls.operationOrder).toEqual(['user.findFirst']);
    expect(calls.findMany).toBeUndefined();
    expect(calls.count).toBeUndefined();
    expect(calls.transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });
});
