import { expect, test } from 'bun:test';
import {
  createCommentBodySchema,
  createReplyBodySchema,
  commentsQuerySchema,
  commentResponseSchema,
  commentParamsSchema,
  commentReplyParamsSchema,
} from '../src/modules/comments/http/schemas.js';
import { Prisma } from '@prisma/client';
import { VIDEO_COMMENT_MAX_LENGTH } from '../src/config/constants.js';
import {
  createReply,
  deleteComment,
  listReplies,
  listComments,
  resolveCommentDeletionOrigin,
  resolveCommentLikeMutation,
} from '../src/modules/comments/service.js';
import {
  toCommentRepliesResponse,
  toCommentsResponse,
} from '../src/modules/comments/http/responses.js';
import { CommentNotFoundError } from '../src/modules/comments/errors.js';
import {
  readableVideoWhere,
  writableVideoEngagementWhere,
} from '../src/modules/videos/shared/readability.js';

test('video comment schemas normalize bounded plain text and validate reply targets', () => {
  expect(
    commentParamsSchema.safeParse({
      videoId: 'v_0123456789abcdef0123456789abcdef',
      commentId: '11111111-1111-4111-8111-111111111111',
    }).success,
  ).toBe(false);
  expect(
    commentReplyParamsSchema.safeParse({
      videoId: 'v_0123456789abcdef0123456789abcdef',
      rootCommentId: '11111111-1111-4111-8111-111111111111',
    }).success,
  ).toBe(false);

  expect(createCommentBodySchema.parse({ content: '  hello  ' })).toEqual({
    content: 'hello',
  });
  expect(
    createReplyBodySchema.safeParse({
      content: 'reply',
      replyingToCommentId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
    }).success,
  ).toBe(true);
  expect(
    createReplyBodySchema.safeParse({
      content: 'reply',
      replyingToCommentId: '11111111-1111-4111-8111-111111111111',
    }).success,
  ).toBe(false);

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
    expect(createCommentBodySchema.safeParse({ content }).success).toBe(false);
  }
  expect(createCommentBodySchema.parse({ content: '👨‍👩‍👧‍👦' })).toEqual({
    content: '👨‍👩‍👧‍👦',
  });
  expect(createCommentBodySchema.parse({ content: 'visible\ufe0f\u034f' })).toEqual({
    content: 'visible\ufe0f\u034f',
  });
  expect(createCommentBodySchema.parse({ content: 'visible\u0007\u001f\u007f' })).toEqual({
    content: 'visible\u0007\u001f\u007f',
  });
  expect(
    createReplyBodySchema.safeParse({
      content: 'reply',
      replyingToCommentId: 'not-a-public-id',
    }).success,
  ).toBe(false);
});

test('video engagement writes exclude rejected and administratively pending-deletion videos', () => {
  expect(writableVideoEngagementWhere).toEqual({
    deletionRequestedAt: null,
    ...readableVideoWhere,
    moderationStatus: {
      not: 'rejected',
    },
  });
});

test('video comment pagination requires a complete stable cursor', () => {
  expect(
    commentsQuerySchema.parse({
      limit: '20',
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
      cursorId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
    }),
  ).toEqual({
    limit: 20,
    cursorCreatedAt: '2026-01-01T00:00:00.000Z',
    cursorId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
  });
  expect(
    commentsQuerySchema.safeParse({
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
    }).success,
  ).toBe(false);
  expect(
    commentsQuerySchema.safeParse({
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
      cursorId: '11111111-1111-4111-8111-111111111111',
    }).success,
  ).toBe(false);
});

test('resolves comment deletion permission in author, owner, then moderation order', () => {
  const authorId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const thirdPartyId = '33333333-3333-4333-8333-333333333333';

  expect(
    resolveCommentDeletionOrigin({
      actorRole: 'admin',
      authorId,
      ownerId: authorId,
      userId: authorId,
    }),
  ).toBe('author');
  expect(
    resolveCommentDeletionOrigin({
      actorRole: 'moderator',
      authorId,
      ownerId,
      userId: ownerId,
    }),
  ).toBe('video_owner');
  expect(
    resolveCommentDeletionOrigin({
      actorRole: 'moderator',
      authorId,
      ownerId,
      userId: thirdPartyId,
    }),
  ).toBe('moderator');
  expect(
    resolveCommentDeletionOrigin({
      actorRole: 'admin',
      authorId,
      ownerId,
      userId: thirdPartyId,
    }),
  ).toBe('admin');
  expect(
    resolveCommentDeletionOrigin({
      actorRole: 'user',
      authorId,
      ownerId,
      userId: thirdPartyId,
    }),
  ).toBeNull();
});

test('public comment DTOs whitelist fields independently of internal deletion metadata', () => {
  const internalComment = {
    id: '11111111-1111-4111-8111-111111111111',
    publicId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
    content: 'Visible comment',
    isDeleted: false as const,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    rootCommentId: null,
    rootCommentPublicId: null,
    replyingTo: null,
    replyCount: 0,
    likeCount: 7,
    viewerHasLiked: true,
    likerIds: ['33333333-3333-4333-8333-333333333333'],
    authorId: '22222222-2222-4222-8222-222222222222',
    deletionOrigin: null,
    role: 'admin',
    author: {
      username: 'comment_author',
      displayName: null,
      avatarUrl: null,
      authorId: '22222222-2222-4222-8222-222222222222',
      role: 'moderator',
    },
  };

  expect(toCommentsResponse({ comments: [internalComment], total: 1, nextCursor: null })).toEqual({
    comments: [
      {
        id: internalComment.publicId,
        content: internalComment.content,
        isDeleted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        rootCommentId: null,
        replyingTo: null,
        replyCount: 0,
        likeCount: 7,
        viewerHasLiked: true,
        author: {
          username: 'comment_author',
          displayName: null,
          avatarUrl: null,
        },
      },
    ],
    total: 1,
    nextCursor: null,
  });

  const internalRootId = '22222222-2222-4222-8222-222222222222';
  const internalReplyingToId = '33333333-3333-4333-8333-333333333333';
  const internalReply = {
    ...internalComment,
    id: '44444444-4444-4444-8444-444444444444',
    publicId: 'c_0d4e55cbc2784d74a192bf7c10888c7b',
    rootCommentId: internalRootId,
    rootCommentPublicId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
    replyingTo: {
      commentId: internalReplyingToId,
      publicCommentId: 'c_0d4e55cbc2784d74a192bf7c10888c7c',
      username: 'reply_target',
    },
  };
  const repliesResponse = toCommentRepliesResponse({
    replies: [internalReply],
    total: 1,
    nextCursor: {
      createdAt: internalReply.createdAt,
      id: internalReply.publicId,
    },
  });

  expect(repliesResponse).toEqual({
    replies: [
      expect.objectContaining({
        id: internalReply.publicId,
        rootCommentId: internalReply.rootCommentPublicId,
        replyingTo: {
          commentId: internalReply.replyingTo.publicCommentId,
          username: 'reply_target',
        },
      }),
    ],
    total: 1,
    nextCursor: {
      id: internalReply.publicId,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const serializedReplies = JSON.stringify(repliesResponse);
  for (const internalId of [internalReply.id, internalRootId, internalReplyingToId]) {
    expect(serializedReplies).not.toContain(internalId);
  }
  expect(
    commentResponseSchema.safeParse({
      comment: {
        id: internalComment.id,
        content: internalComment.content,
        isDeleted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        rootCommentId: null,
        likeCount: 0,
        viewerHasLiked: false,
        replyingTo: null,
        author: { username: 'comment_author', displayName: null, avatarUrl: null },
      },
    }).success,
  ).toBe(false);
});

test('comment like mutations are idempotent in both directions', () => {
  expect(resolveCommentLikeMutation('like', false)).toEqual({
    changeFact: true,
    likeCountDelta: 1,
  });
  expect(resolveCommentLikeMutation('like', true)).toEqual({
    changeFact: false,
    likeCountDelta: 0,
  });
  expect(resolveCommentLikeMutation('unlike', true)).toEqual({
    changeFact: true,
    likeCountDelta: -1,
  });
  expect(resolveCommentLikeMutation('unlike', false)).toEqual({
    changeFact: false,
    likeCountDelta: 0,
  });
});

test.each([
  {
    name: 'target video owner with a missing id',
    actorRole: 'user' as const,
    userId: '22222222-2222-4222-8222-222222222222',
    candidate: null,
  },
  {
    name: 'owner of another video with a nonqualifying candidate',
    actorRole: 'user' as const,
    userId: '33333333-3333-4333-8333-333333333333',
    candidate: {
      authorId: '44444444-4444-4444-8444-444444444444',
      video: { ownerId: '22222222-2222-4222-8222-222222222222' },
    },
  },
  {
    name: 'moderator with a missing id',
    actorRole: 'moderator' as const,
    userId: '55555555-5555-4555-8555-555555555555',
    candidate: null,
  },
  {
    name: 'administrator with a missing id',
    actorRole: 'admin' as const,
    userId: '66666666-6666-4666-8666-666666666666',
    candidate: null,
  },
])('comment deletion rejects $name before opening a transaction', async (testCase) => {
  let findFirstArgs: unknown;
  let transactionCalls = 0;
  const prisma = {
    comment: {
      findFirst: async (args: unknown) => {
        findFirstArgs = args;
        return testCase.candidate;
      },
    },
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error('The deletion transaction must not start');
    },
  };

  await expect(
    deleteComment(
      {
        clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
        prisma: prisma as never,
      },
      {
        publicId: 'AbCdEf123_',
        commentId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
        userId: testCase.userId,
        actorRole: testCase.actorRole,
      },
    ),
  ).rejects.toBeInstanceOf(CommentNotFoundError);
  expect(findFirstArgs).toEqual({
    where: {
      publicId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
      video: {
        publicId: 'AbCdEf123_',
      },
    },
    select: {
      id: true,
      authorId: true,
      video: {
        select: {
          ownerId: true,
        },
      },
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
  const rootCommentIds = Array.from(
    { length: 20 },
    (_, index) => `c_${index.toString().padStart(32, '0')}`,
  );
  const results = await Promise.allSettled(
    rootCommentIds.map((rootCommentId) =>
      createReply(
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
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(CommentNotFoundError);
  }
  expect(findManyArgs).toEqual(
    rootCommentIds.map((rootCommentId) => ({
      where: {
        publicId: {
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
        publicId: true,
        rootId: true,
      },
    })),
  );
  expect(transactionCalls).toBe(0);
});

test('invalid or foreign reply targets are rejected before opening video transactions', async () => {
  const rootCommentId = 'c_0d4e55cbc2784d74a192bf7c10888c7a';
  const rootInternalId = '11111111-1111-4111-8111-111111111111';
  const missingTargetId = 'c_0d4e55cbc2784d74a192bf7c10888c7b';
  const foreignTargetId = 'c_0d4e55cbc2784d74a192bf7c10888c7c';
  let transactionCalls = 0;
  const prisma = {
    comment: {
      findMany: async ({ where }: { where: { publicId: { in: string[] } } }) => {
        const targetId = where.publicId.in[1];

        return [
          { id: rootInternalId, publicId: rootCommentId, rootId: null },
          ...(targetId === foreignTargetId
            ? [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  publicId: foreignTargetId,
                  rootId: '33333333-3333-4333-8333-333333333333',
                },
              ]
            : []),
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
      createReply(
        { prisma: prisma as never },
        {
          publicId: 'AbCdEf123_',
          rootCommentId,
          replyingToCommentId,
          userId: '55555555-5555-4555-8555-555555555555',
          content: 'This target must fail during preflight.',
        },
      ),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  }

  expect(transactionCalls).toBe(0);
});

test('root pages use the descending cursor bound and calculate reply counts with one grouped query', async () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const cursor = {
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    id: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
  };
  const cursorInternalId = '44444444-4444-4444-8444-444444444444';
  const firstRootId = '11111111-1111-4111-8111-111111111111';
  const secondRootId = '22222222-2222-4222-8222-222222222222';
  const roots = [firstRootId, secondRootId, '33333333-3333-4333-8333-333333333333'].map((id) => ({
    id,
    publicId: `c_${id.replaceAll('-', '')}`,
    content: `comment-${id}`,
    rootId: null,
    createdAt,
    deletedAt: null,
    likeCount: 2,
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
      findFirst: async () => ({ id: cursorInternalId }),
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
    commentLike: {
      findMany: async () => [{ commentId: firstRootId }],
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

  const result = await listComments(
    { prisma: prisma as never },
    {
      publicId: 'AbCdEf123_',
      viewerUserId: '99999999-9999-4999-8999-999999999999',
      cursor,
      limit: 2,
    },
  );

  expect(groupByCalls).toBe(1);
  expect(isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
  expect(result.comments.map(({ id, replyCount }) => ({ id, replyCount }))).toEqual([
    { id: firstRootId, replyCount: 2 },
    { id: secondRootId, replyCount: 1 },
  ]);
  expect(
    result.comments.map(({ id, likeCount, viewerHasLiked }) => ({
      id,
      likeCount,
      viewerHasLiked,
    })),
  ).toEqual([
    { id: firstRootId, likeCount: 2, viewerHasLiked: true },
    { id: secondRootId, likeCount: 2, viewerHasLiked: false },
  ]);
  expect(result.nextCursor).toEqual({
    createdAt,
    id: `c_${secondRootId.replaceAll('-', '')}`,
  });
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
                { createdAt: cursor.createdAt, id: { lt: cursorInternalId } },
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
  const rootCommentId = 'c_0d4e55cbc2784d74a192bf7c10888c7a';
  const rootInternalId = '11111111-1111-4111-8111-111111111111';
  const cursor = {
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    id: 'c_0d4e55cbc2784d74a192bf7c10888c7b',
  };
  const cursorInternalId = '22222222-2222-4222-8222-222222222222';
  let findManyArgs: unknown;
  const tx = {
    video: {
      findFirst: async () => ({ id: videoId }),
    },
    comment: {
      findFirst: async ({ where }: { where: { publicId: string } }) => ({
        id: where.publicId === rootCommentId ? rootInternalId : cursorInternalId,
      }),
      findMany: async (args: unknown) => {
        findManyArgs = args;
        return [];
      },
      count: async () => 0,
    },
    commentLike: {
      findMany: async () => {
        throw new Error('Anonymous comment pages must not query viewer likes');
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };

  await listReplies({ prisma: prisma as never }, { publicId: 'AbCdEf123_', rootCommentId, cursor });

  expect(findManyArgs).toMatchObject({
    where: {
      AND: [
        { videoId, rootId: rootInternalId, deletedAt: null },
        {
          AND: [
            { createdAt: { gte: cursor.createdAt } },
            {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursorInternalId } },
              ],
            },
          ],
        },
      ],
    },
  });
});
