import { expect, test } from 'bun:test';
import {
  createVideoCommentBodySchema,
  createVideoCommentReplyBodySchema,
  videoCommentsQuerySchema,
} from '../src/controllers/videos.schemas.js';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { VIDEO_COMMENT_MAX_LENGTH } from '../src/config/constants.js';
import {
  createVideoCommentReply,
  deleteVideoComment,
  listVideoCommentReplies,
  listVideoComments,
} from '../src/services/videos/videoComments.js';
import { VideoCommentNotFoundError } from '../src/services/videos.errors.js';
import {
  readableVideoWhere,
  writableVideoEngagementWhere,
} from '../src/services/videos/videoReadability.js';

test('video comment schemas normalize bounded plain text and validate reply targets', () => {
  expect(createVideoCommentBodySchema.parse({ content: '  hello  ' })).toEqual({
    content: 'hello',
  });
  expect(
    createVideoCommentReplyBodySchema.safeParse({
      content: 'reply',
      replyingToCommentId: '11111111-1111-4111-8111-111111111111',
    }).success,
  ).toBe(true);

  for (const content of [
    '',
    '   ',
    '\u200b\u2060\u200d\u200e',
    '\ufe0f',
    '\u034f',
    '\u0007',
    '\u001f',
    '\u007f',
    'contains\u0000nul',
    'x'.repeat(VIDEO_COMMENT_MAX_LENGTH + 1),
  ]) {
    expect(createVideoCommentBodySchema.safeParse({ content }).success).toBe(false);
  }
  expect(createVideoCommentBodySchema.parse({ content: '👨‍👩‍👧‍👦' })).toEqual({
    content: '👨‍👩‍👧‍👦',
  });
  expect(createVideoCommentBodySchema.parse({ content: 'visible\ufe0f\u034f' })).toEqual({
    content: 'visible\ufe0f\u034f',
  });
  expect(createVideoCommentBodySchema.parse({ content: 'visible\u0007\u001f\u007f' })).toEqual({
    content: 'visible\u0007\u001f\u007f',
  });
  expect(
    createVideoCommentReplyBodySchema.safeParse({
      content: 'reply',
      replyingToCommentId: 'not-a-uuid',
    }).success,
  ).toBe(false);
});

test('video engagement writes extend the centralized readability scope with rejection only', () => {
  expect(writableVideoEngagementWhere).toEqual({
    ...readableVideoWhere,
    moderationStatus: {
      not: 'rejected',
    },
  });
});

test('video comment pagination requires a complete stable cursor', () => {
  expect(
    videoCommentsQuerySchema.parse({
      limit: '20',
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
      cursorId: '11111111-1111-4111-8111-111111111111',
    }),
  ).toEqual({
    limit: 20,
    cursorCreatedAt: '2026-01-01T00:00:00.000Z',
    cursorId: '11111111-1111-4111-8111-111111111111',
  });
  expect(
    videoCommentsQuerySchema.safeParse({
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
    }).success,
  ).toBe(false);
});

test('comment deletion rejects an unowned or missing id before opening a transaction', async () => {
  let findFirstArgs: unknown;
  let transactionCalls = 0;
  const prisma = {
    comment: {
      findFirst: async (args: unknown) => {
        findFirstArgs = args;
        return null;
      },
    },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('The deletion transaction must not start');
    },
  };

  await expect(
    deleteVideoComment(
      {
        clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
        prisma: prisma as never,
      },
      {
        publicId: 'AbCdEf123_',
        commentId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
      },
    ),
  ).rejects.toBeInstanceOf(VideoCommentNotFoundError);
  expect(findFirstArgs).toEqual({
    where: {
      id: '11111111-1111-4111-8111-111111111111',
      authorId: '22222222-2222-4222-8222-222222222222',
      video: {
        publicId: 'AbCdEf123_',
      },
    },
    select: {
      id: true,
    },
  });
  expect(transactionCalls).toBe(0);
});

test('missing reply roots are rejected by indexed preflight without opening video transactions', async () => {
  const findManyArgs: unknown[] = [];
  let transactionCalls = 0;
  const prisma = {
    comment: {
      findMany: async (args: unknown) => {
        findManyArgs.push(args);
        return [];
      },
    },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('An invalid reply root must not reach the video-lock transaction');
    },
  };
  const rootCommentIds = Array.from({ length: 20 }, () => randomUUID());
  const results = await Promise.allSettled(
    rootCommentIds.map((rootCommentId) =>
      createVideoCommentReply(
        { prisma: prisma as never },
        {
          publicId: 'AbCdEf123_',
          rootCommentId,
          userId: '22222222-2222-4222-8222-222222222222',
          content: 'This root does not exist.',
        },
      ),
    ),
  );

  expect(results).toHaveLength(rootCommentIds.length);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(VideoCommentNotFoundError);
  }
  expect(findManyArgs).toEqual(
    rootCommentIds.map((rootCommentId) => ({
      where: {
        id: {
          in: [rootCommentId, rootCommentId],
        },
        deletedAt: null,
        video: {
          publicId: 'AbCdEf123_',
          ...writableVideoEngagementWhere,
        },
      },
      select: {
        id: true,
        rootId: true,
      },
    })),
  );
  expect(transactionCalls).toBe(0);
});

test('invalid or foreign reply targets are rejected before opening video transactions', async () => {
  const rootCommentId = '11111111-1111-4111-8111-111111111111';
  const missingTargetId = '22222222-2222-4222-8222-222222222222';
  const foreignTargetId = '33333333-3333-4333-8333-333333333333';
  const foreignRootId = '44444444-4444-4444-8444-444444444444';
  let transactionCalls = 0;
  const prisma = {
    comment: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const targetId = where.id.in[1];

        return [
          { id: rootCommentId, rootId: null },
          ...(targetId === foreignTargetId ? [{ id: foreignTargetId, rootId: foreignRootId }] : []),
        ];
      },
    },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('An invalid reply target must not reach the video-lock transaction');
    },
  };

  for (const replyingToCommentId of [missingTargetId, foreignTargetId]) {
    await expect(
      createVideoCommentReply(
        { prisma: prisma as never },
        {
          publicId: 'AbCdEf123_',
          rootCommentId,
          replyingToCommentId,
          userId: '55555555-5555-4555-8555-555555555555',
          content: 'This target must fail during preflight.',
        },
      ),
    ).rejects.toBeInstanceOf(VideoCommentNotFoundError);
  }

  expect(transactionCalls).toBe(0);
});

test('root comment pages calculate every replyCount with one grouped query', async () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const cursor = {
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    id: '44444444-4444-4444-8444-444444444444',
  };
  const firstRootId = '11111111-1111-4111-8111-111111111111';
  const secondRootId = '22222222-2222-4222-8222-222222222222';
  const roots = [firstRootId, secondRootId, '33333333-3333-4333-8333-333333333333'].map((id) => ({
    id,
    content: `comment-${id}`,
    rootId: null,
    createdAt,
    deletedAt: null,
    author: {
      username: `user-${id}`,
      displayName: null,
      mediaAssets: [],
    },
    replyingToComment: null,
  }));
  let groupByCalls = 0;
  let findManyArgs: unknown;
  let isolationLevel: Prisma.TransactionIsolationLevel | undefined;
  const tx = {
    video: {
      findFirst: async () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    },
    comment: {
      findMany: async (args: unknown) => {
        findManyArgs = args;
        return roots;
      },
      groupBy: async () => {
        groupByCalls += 1;

        return [
          { rootId: firstRootId, _count: { _all: 2 } },
          { rootId: secondRootId, _count: { _all: 1 } },
        ];
      },
      count: async () => 3,
    },
  };
  const prisma = {
    $transaction: async (
      callback: (transaction: typeof tx) => Promise<unknown>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      isolationLevel = options.isolationLevel;

      return callback(tx);
    },
  };

  const result = await listVideoComments(
    { prisma: prisma as never },
    { publicId: 'AbCdEf123_', cursor, limit: 2 },
  );

  expect(groupByCalls).toBe(1);
  expect(isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
  expect(result.comments.map(({ id, replyCount }) => ({ id, replyCount }))).toEqual([
    { id: firstRootId, replyCount: 2 },
    { id: secondRootId, replyCount: 1 },
  ]);
  expect(result.nextCursor).toEqual({ createdAt, id: secondRootId });
  expect(result.total).toBe(3);
  expect(findManyArgs).toMatchObject({
    where: {
      AND: [
        expect.anything(),
        {
          AND: [
            { createdAt: { lte: cursor.createdAt } },
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        },
      ],
    },
  });
});

test('reply pages add an ascending temporal index bound around the cursor tie-break', async () => {
  const videoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rootCommentId = '11111111-1111-4111-8111-111111111111';
  const cursor = {
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    id: '22222222-2222-4222-8222-222222222222',
  };
  let findManyArgs: unknown;
  const tx = {
    video: {
      findFirst: async () => ({ id: videoId }),
    },
    comment: {
      findFirst: async () => ({ id: rootCommentId }),
      findMany: async (args: unknown) => {
        findManyArgs = args;
        return [];
      },
      count: async () => 0,
    },
  };
  const prisma = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };

  await listVideoCommentReplies(
    { prisma: prisma as never },
    { publicId: 'AbCdEf123_', rootCommentId, cursor },
  );

  expect(findManyArgs).toMatchObject({
    where: {
      AND: [
        { videoId, rootId: rootCommentId, deletedAt: null },
        {
          AND: [
            { createdAt: { gte: cursor.createdAt } },
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            },
          ],
        },
      ],
    },
  });
});
