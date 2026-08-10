import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import type { VideosDependencies } from '../src/services/videos/videos.dependencies.js';
import { createVideosService } from '../src/services/videos.service.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';
import { calculateVideoRatingAverage } from '../src/services/videos/videoRating.js';

const createdAt = new Date('2026-01-01T00:00:00.000Z');
const publishedAt = new Date('2026-01-02T00:00:00.000Z');

const videoRecord = {
  publicId: 'AbCdEf123_',
  title: 'Me at the zoo',
  description: '00:00 Intro 00:05 The cool thing 00:17 End.',
  tags: ['zoo', 'elephants'],
  license: 'cc_by' as const,
  visibility: 'unlisted' as const,
  allowComments: true,
  ratingSum: 9,
  ratingCount: 2,
  viewCount: 128,
  commentCount: 42,
  durationSeconds: 19,
  publishedAt,
  createdAt,
  owner: {
    username: 'jawed',
    displayName: 'Jawed Karim' as string | null,
    mediaAssets: [{ id: 'avatar-asset-id', kind: 'avatar' as const }],
  },
  activeArtifactGeneration: {
    id: '11111111-1111-4111-8111-111111111111',
  },
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  moderationStatus: 'rejected',
  processingStatus: 'ready',
  hlsMasterObjectKey: 'owners/internal/hls/master.m3u8',
  thumbnailObjectKey: 'owners/internal/thumbnail.webp',
  rejectionReason: 'Internal moderation detail',
  bucket: 'internal-video-bucket',
  objectKey: 'internal-object-key',
};

const createDeps = ({
  record = videoRecord,
  userRating = 5 as number | null,
  viewWriteError,
}: {
  record?: typeof videoRecord | null;
  userRating?: number | null;
  viewWriteError?: Error;
} = {}) => {
  const calls: {
    transactionOptions?: unknown;
    videoFindFirst?: unknown;
    ratingFindFirst?: unknown;
    ratingFindFirstCalls: number;
    viewWriteCalls: number;
    warnings: unknown[];
  } = {
    ratingFindFirstCalls: 0,
    viewWriteCalls: 0,
    warnings: [],
  };
  const tx = {
    video: {
      findFirst: async (args: unknown) => {
        calls.videoFindFirst = args;
        return record;
      },
    },
    videoRating: {
      findFirst: async (args: unknown) => {
        calls.ratingFindFirst = args;
        calls.ratingFindFirstCalls += 1;
        return userRating === null ? null : { value: userRating };
      },
    },
  };
  const deps = {
    prisma: {
      $transaction: async (run: (transaction: typeof tx) => Promise<unknown>, options: unknown) => {
        calls.transactionOptions = options;
        return run(tx);
      },
      $executeRaw: async () => {
        calls.viewWriteCalls += 1;
        if (viewWriteError) {
          throw viewWriteError;
        }
        return 1;
      },
    },
    clock: { now: () => new Date('2026-01-03T12:00:00.000Z') },
    logger: {
      warn: (data: unknown) => calls.warnings.push(data),
    },
  } as unknown as VideosDependencies;

  return { calls, deps };
};

describe('public video detail service', () => {
  test('builds an authenticated detail from one readable snapshot and whitelists the DTO', async () => {
    const { calls, deps } = createDeps();
    const result = await createVideosService(deps).getPublicVideoDetail({
      publicId: videoRecord.publicId,
      userId: '44444444-4444-4444-8444-444444444444',
    });

    expect(result).toEqual({
      video: {
        publicId: videoRecord.publicId,
        title: videoRecord.title,
        description: videoRecord.description,
        tags: videoRecord.tags,
        license: videoRecord.license,
        visibility: videoRecord.visibility,
        commentsOpen: false,
        createdAt,
        publishedAt,
        thumbnailPath: '/videos/AbCdEf123_/thumbnail',
        creator: {
          username: 'jawed',
          displayName: 'Jawed Karim',
          avatarUrl: '/profiles/jawed/avatar',
        },
        ratingAverage: calculateVideoRatingAverage(9, 2),
        ratingCount: 2,
        userRating: 5,
        viewCount: 128,
        commentCount: 42,
        duration: 19,
        hlsMasterPath: '/videos/AbCdEf123_/hls/master.m3u8',
      },
    });
    expect(calls.transactionOptions).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(calls.videoFindFirst).toEqual(
      expect.objectContaining({
        where: {
          publicId: videoRecord.publicId,
          processingStatus: 'ready',
          visibility: { in: ['public', 'unlisted'] },
          activeArtifactGeneration: {
            is: {
              state: 'active',
              renditions: { some: {} },
            },
          },
        },
      }),
    );
    expect(calls.videoFindFirst).not.toHaveProperty('where.moderationStatus');
    expect(calls.ratingFindFirst).toEqual({
      where: {
        userId: '44444444-4444-4444-8444-444444444444',
        video: { publicId: videoRecord.publicId },
      },
      select: { value: true },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'ownerId',
      'moderationStatus',
      'processingStatus',
      'hlsMasterObjectKey',
      'thumbnailObjectKey',
      'rejectionReason',
      'bucket',
      'objectKey',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(result.video).not.toHaveProperty('id');
    expect(calls.viewWriteCalls).toBe(1);
  });

  test('keeps anonymous unrated details functional and maps missing avatars to null', async () => {
    const { calls, deps } = createDeps({
      record: {
        ...videoRecord,
        ratingSum: 0,
        ratingCount: 0,
        owner: {
          ...videoRecord.owner,
          displayName: null,
          mediaAssets: [],
        },
      },
    });

    const result = await createVideosService(deps).getPublicVideoDetail({
      publicId: videoRecord.publicId,
    });

    expect(result.video.creator).toEqual({
      username: 'jawed',
      displayName: null,
      avatarUrl: null,
    });
    expect(result.video.ratingAverage).toBe(calculateVideoRatingAverage(0, 0));
    expect(result.video.ratingCount).toBe(0);
    expect(result.video.userRating).toBeNull();
    expect(calls.ratingFindFirstCalls).toBe(0);
    expect(calls.viewWriteCalls).toBe(0);
  });

  test('returns the uniform not-found error without querying a rating when no playable video exists', async () => {
    const { calls, deps } = createDeps({ record: null });

    await expect(
      createVideosService(deps).getPublicVideoDetail({
        publicId: videoRecord.publicId,
        userId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundError);
    expect(calls.ratingFindFirstCalls).toBe(0);
    expect(calls.viewWriteCalls).toBe(0);
  });

  test('never schedules a view for the video owner', async () => {
    const { calls, deps } = createDeps();

    await createVideosService(deps).getPublicVideoDetail({
      publicId: videoRecord.publicId,
      userId: videoRecord.ownerId,
    });

    expect(calls.viewWriteCalls).toBe(0);
  });

  test('keeps the detail successful when best-effort view recording fails', async () => {
    const viewWriteError = new Error('view storage unavailable');
    const { calls, deps } = createDeps({ viewWriteError });

    const result = await createVideosService(deps).getPublicVideoDetail({
      publicId: videoRecord.publicId,
      userId: '44444444-4444-4444-8444-444444444444',
    });
    await Promise.resolve();

    expect(result.video.publicId).toBe(videoRecord.publicId);
    expect(calls.viewWriteCalls).toBe(1);
    expect(calls.warnings).toEqual([
      expect.objectContaining({
        err: viewWriteError,
        userId: '44444444-4444-4444-8444-444444444444',
        videoId: videoRecord.id,
        viewedOn: '2026-01-03',
      }),
    ]);
  });
});
