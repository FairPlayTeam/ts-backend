import type { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  listVideoCommentReplies,
  listVideoComments,
} from '../../src/services/videos/videoComments.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import { createPlayableVideo } from './support/playableVideo.js';
import {
  createIntegrationApp,
  createIntegrationAdminService,
  createIntegrationAuthService,
  createIntegrationVideosService,
  createQueryObservedPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';
import {
  coordinateGatedOperations,
  coordinateLockInterleaving,
  coordinateWhilePaused,
  waitForBarrier,
} from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  beginHeldActorDowngrade,
  waitForBlockedActorAuthorizationQuery,
} from './support/actorAuthorization.js';

type TransactionRawBarrier = {
  after?: () => Promise<void> | void;
  call: number;
};

const waitForBlockedVideoQueries = async (
  runtime: TestRuntime,
  expectedCount: number,
  timeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<void> =>
  waitForPostgresLockWaiters(runtime.prisma, {
    applicationNames: [runtime.postgresApplicationName],
    expectedCount,
    queryFragments: ['FROM "videos"'],
    ...(signal === undefined ? {} : { signal }),
    timeoutMs,
  });

const createBarrierPrisma = (
  prisma: PrismaClient,
  {
    afterCommentCandidates,
    afterVideoCandidates,
    onTransactionStart,
    transactionRawBarrier,
  }: {
    afterCommentCandidates?: () => Promise<void> | void;
    afterVideoCandidates?: () => Promise<void> | void;
    onTransactionStart?: () => void;
    transactionRawBarrier?: TransactionRawBarrier;
  },
): PrismaClient => {
  let candidateBarrierUsed = false;
  let commentCandidateBarrierUsed = false;
  let rawBarrierUsed = false;

  return new Proxy(prisma, {
    get(target, property) {
      if (property === 'comment' && afterCommentCandidates) {
        return new Proxy(target.comment, {
          get(commentTarget, commentProperty) {
            if (commentProperty === 'findMany') {
              return async (...args: Parameters<typeof commentTarget.findMany>) => {
                const result = await commentTarget.findMany(...args);

                if (!commentCandidateBarrierUsed) {
                  commentCandidateBarrierUsed = true;
                  await afterCommentCandidates();
                }

                return result;
              };
            }

            const value = Reflect.get(commentTarget, commentProperty, commentTarget) as unknown;

            return typeof value === 'function' ? value.bind(commentTarget) : value;
          },
        });
      }

      if (property === 'video' && afterVideoCandidates) {
        return new Proxy(target.video, {
          get(videoTarget, videoProperty) {
            if (videoProperty === 'findMany') {
              return async (...args: Parameters<typeof videoTarget.findMany>) => {
                const result = await videoTarget.findMany(...args);

                if (!candidateBarrierUsed) {
                  candidateBarrierUsed = true;
                  await afterVideoCandidates();
                }

                return result;
              };
            }

            const value = Reflect.get(videoTarget, videoProperty, videoTarget) as unknown;

            return typeof value === 'function' ? value.bind(videoTarget) : value;
          },
        });
      }

      if (property === '$transaction' && (onTransactionStart || transactionRawBarrier)) {
        return async <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ): Promise<T> => {
          onTransactionStart?.();

          if (!transactionRawBarrier) {
            return target.$transaction(run, options);
          }

          return target.$transaction(async (tx) => {
            let rawCall = 0;
            const barrierTransaction = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === '$queryRaw') {
                  return async <QueryResult>(query: Prisma.Sql): Promise<QueryResult> => {
                    rawCall += 1;
                    const useBarrier =
                      transactionRawBarrier !== undefined &&
                      !rawBarrierUsed &&
                      rawCall === transactionRawBarrier.call;

                    if (useBarrier) {
                      rawBarrierUsed = true;
                    }

                    const result = await tx.$queryRaw<QueryResult>(query);

                    if (useBarrier) {
                      await transactionRawBarrier?.after?.();
                    }

                    return result;
                  };
                }

                const value = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                  transactionTarget,
                ) as unknown;

                return typeof value === 'function' ? value.bind(transactionTarget) : value;
              },
            }) as Prisma.TransactionClient;

            return run(barrierTransaction);
          }, options);
        };
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const expectConstraintViolation = async (
  operation: Promise<unknown>,
  constraintName: string,
): Promise<void> => {
  try {
    await operation;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(constraintName);
    return;
  }

  throw new Error(`Expected PostgreSQL constraint ${constraintName} to reject the write`);
};

type ExplainPlanRow = {
  'QUERY PLAN': string;
};

type ObservedQuery = Pick<Prisma.QueryEvent, 'params' | 'query'>;

const findEmittedCommentPageQuery = (queries: readonly ObservedQuery[]): ObservedQuery => {
  const pageQueries = queries.filter(
    ({ query }) =>
      query.includes('"comments"') && query.includes('ORDER BY') && query.includes('LIMIT'),
  );

  expect(pageQueries).toHaveLength(1);

  const pageQuery = pageQueries[0];

  if (!pageQuery) {
    throw new Error('Expected Prisma to emit one ordered comment page query');
  }

  return pageQuery;
};

const explainObservedQuery = async (
  prisma: PrismaClient,
  { params, query }: ObservedQuery,
): Promise<ExplainPlanRow[]> => {
  const parsedParameters = JSON.parse(params) as unknown;

  if (!Array.isArray(parsedParameters)) {
    throw new Error('Expected Prisma query parameters to be encoded as an array');
  }

  return prisma.$queryRawUnsafe<ExplainPlanRow[]>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`,
    ...parsedParameters,
  );
};

const expectBoundedCommentCursorPlan = (rows: readonly ExplainPlanRow[]): void => {
  const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
  const executedSequentialScans = plan
    .split('\n')
    .filter((line) => line.includes('Seq Scan') && !line.includes('(never executed)'));
  const bufferLine = plan.match(/Buffers: shared hit=(\d+)(?: read=(\d+))?/);
  const rowsRemoved = [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );

  expect(plan).toMatch(/Index (?:Only )?Scan/);
  expect(plan).toMatch(/Index Cond: .*created_at (?:<=|>=)/);
  expect(executedSequentialScans).toEqual([]);
  expect(plan).not.toContain('Bitmap Heap Scan');
  expect(bufferLine).not.toBeNull();
  expect(Number(bufferLine?.[1] ?? 0) + Number(bufferLine?.[2] ?? 0)).toBeLessThan(256);
  expect(rowsRemoved).toBeLessThan(256);
};

describe('video comments integration', () => {
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

  test('enforces the active/deleted lifecycle invariant in PostgreSQL itself', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-constraint-owner@example.com',
      username: 'constraint_owner',
    });
    const commenter = await createVerifiedSession(runtime, {
      email: 'comment-constraint-author@example.com',
      username: 'constraint_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment lifecycle constraint',
      visibility: 'public',
    });

    await expectConstraintViolation(
      runtime.prisma.$executeRaw`
        INSERT INTO "comments" (
          "id",
          "author_id",
          "video_id",
          "content",
          "deleted_at",
          "deletion_origin"
        )
        VALUES (
          CAST('11111111-1111-4111-8111-111111111111' AS UUID),
          CAST(${commenter.userId} AS UUID),
          CAST(${video.id} AS UUID),
          'content that must have been cleared',
          CURRENT_TIMESTAMP,
          'author'
        )
      `,
      'comments_lifecycle_state_check',
    );

    await expectConstraintViolation(
      runtime.prisma.$executeRaw`
        INSERT INTO "comments" (
          "id",
          "author_id",
          "video_id",
          "content",
          "deletion_origin"
        )
        VALUES (
          CAST('22222222-2222-4222-8222-222222222222' AS UUID),
          CAST(${commenter.userId} AS UUID),
          CAST(${video.id} AS UUID),
          'active content cannot have a deletion origin',
          'moderator'
        )
      `,
      'comments_deletion_origin_state_check',
    );

    await expectConstraintViolation(
      runtime.prisma.$executeRaw`
        INSERT INTO "comments" (
          "id",
          "author_id",
          "video_id",
          "deleted_at"
        )
        VALUES (
          CAST('33333333-3333-4333-8333-333333333333' AS UUID),
          CAST(${commenter.userId} AS UUID),
          CAST(${video.id} AS UUID),
          CURRENT_TIMESTAMP
        )
      `,
      'comments_deletion_origin_state_check',
    );

    await expect(runtime.prisma.comment.count()).resolves.toBe(0);
  });

  test('enforces thread shape and nonnegative comment aggregates in PostgreSQL itself', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-shape-owner@example.com',
      username: 'shape_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-shape-author@example.com',
      username: 'shape_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment structural constraints',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'A valid root for the invalid reply reference.',
      })
    ).comment;

    await expectConstraintViolation(
      runtime.prisma.$executeRaw`
        INSERT INTO "comments" (
          "id",
          "author_id",
          "video_id",
          "root_id",
          "content"
        )
        VALUES (
          CAST('11111111-1111-4111-8111-111111111112' AS UUID),
          CAST(${author.userId} AS UUID),
          CAST(${video.id} AS UUID),
          CAST(${root.id} AS UUID),
          'A reply shape missing its reply target.'
        )
      `,
      'comments_thread_shape_check',
    );
    await expectConstraintViolation(
      runtime.prisma.$executeRaw`
        UPDATE "videos"
        SET "comment_count" = -1
        WHERE "id" = CAST(${video.id} AS UUID)
      `,
      'videos_comment_count_nonnegative_check',
    );

    await expect(runtime.prisma.comment.count({ where: { videoId: video.id } })).resolves.toBe(1);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 1 });
  });

  test('creates a root and flattens replies to replies onto that root', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-thread-owner@example.com',
      username: 'thread_owner',
    });
    const firstAuthorUsername = 'thread_first';
    const firstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-thread-first@example.com',
      username: firstAuthorUsername,
    });
    const secondAuthorUsername = 'thread_second';
    const secondAuthor = await createVerifiedSession(runtime, {
      email: 'comment-thread-second@example.com',
      username: secondAuthorUsername,
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'One-level comment thread',
      visibility: 'public',
    });

    const rootResponse = await request(app)
      .post(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${firstAuthor.sessionKey}`)
      .send({ content: '  A root comment.  ' })
      .expect(201)
      .expect('Cache-Control', 'no-store');
    const rootId = rootResponse.body.comment.id as string;

    expect(rootResponse.body).toEqual({
      comment: {
        id: rootId,
        content: 'A root comment.',
        isDeleted: false,
        createdAt: expect.any(String),
        rootCommentId: null,
        likeCount: 0,
        viewerHasLiked: false,
        replyingTo: null,
        author: {
          username: firstAuthorUsername,
          displayName: firstAuthorUsername,
          avatarUrl: null,
        },
      },
    });

    const directReplyResponse = await request(app)
      .post(`/videos/${video.publicId}/comments/${rootId}/replies`)
      .set('Authorization', `Bearer ${secondAuthor.sessionKey}`)
      .send({ content: 'A direct reply.' })
      .expect(201);
    const directReplyId = directReplyResponse.body.comment.id as string;

    expect(directReplyResponse.body.comment).toMatchObject({
      content: 'A direct reply.',
      rootCommentId: rootId,
      replyingTo: {
        commentId: rootId,
        username: firstAuthorUsername,
      },
    });

    const nestedConversationResponse = await request(app)
      .post(`/videos/${video.publicId}/comments/${rootId}/replies`)
      .set('Authorization', `Bearer ${firstAuthor.sessionKey}`)
      .send({
        content: 'Still physically one level deep.',
        replyingToCommentId: directReplyId,
      })
      .expect(201);

    expect(nestedConversationResponse.body.comment).toMatchObject({
      rootCommentId: rootId,
      replyingTo: {
        commentId: directReplyId,
        username: secondAuthorUsername,
      },
    });

    const rows = await runtime.prisma.comment.findMany({
      where: { videoId: video.id },
      select: {
        id: true,
        rootId: true,
        replyingToCommentId: true,
      },
    });
    const rowsById = new Map(rows.map((row) => [row.id, row]));

    expect(rowsById.get(rootId)).toEqual({
      id: rootId,
      rootId: null,
      replyingToCommentId: null,
    });
    expect(rowsById.get(directReplyId)).toEqual({
      id: directReplyId,
      rootId,
      replyingToCommentId: rootId,
    });
    expect(rowsById.get(nestedConversationResponse.body.comment.id)).toEqual({
      id: nestedConversationResponse.body.comment.id,
      rootId,
      replyingToCommentId: directReplyId,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 3 });

    const otherRootResponse = await request(app)
      .post(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${secondAuthor.sessionKey}`)
      .send({ content: 'A separate root.' })
      .expect(201);

    await request(app)
      .post(`/videos/${video.publicId}/comments/${rootId}/replies`)
      .set('Authorization', `Bearer ${firstAuthor.sessionKey}`)
      .send({
        content: 'Must not cross threads.',
        replyingToCommentId: otherRootResponse.body.comment.id,
      })
      .expect(404);

    const otherVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'A different comment thread video',
      visibility: 'public',
    });
    const otherVideoRoot = (
      await runtime.videosService.createVideoComment({
        publicId: otherVideo.publicId,
        userId: secondAuthor.userId,
        content: 'A root on another video.',
      })
    ).comment;

    await request(app)
      .post(`/videos/${video.publicId}/comments/${rootId}/replies`)
      .set('Authorization', `Bearer ${firstAuthor.sessionKey}`)
      .send({
        content: 'Must not cross videos.',
        replyingToCommentId: otherVideoRoot.id,
      })
      .expect(404);

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 4 });
  });

  test('never exposes corrupt cross-video replies through roots, counts, or reply pages', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-cross-video-owner@example.com',
      username: 'cross_video_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-cross-video-author@example.com',
      username: 'cross_video_author',
    });
    const firstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Cross-video read isolation source',
      visibility: 'public',
    });
    const secondVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Cross-video read isolation corrupt row owner',
      visibility: 'public',
    });
    const activeRoot = (
      await runtime.videosService.createVideoComment({
        publicId: firstVideo.publicId,
        userId: author.userId,
        content: 'Active root must report no corrupt replies.',
      })
    ).comment;
    const deletedRoot = (
      await runtime.videosService.createVideoComment({
        publicId: firstVideo.publicId,
        userId: author.userId,
        content: 'Deleted root must not become a corrupt placeholder.',
      })
    ).comment;

    await runtime.prisma.$executeRaw`
      INSERT INTO "comments" (
        "id",
        "author_id",
        "video_id",
        "root_id",
        "replying_to_comment_id",
        "content"
      )
      VALUES
        (
          CAST('22222222-2222-4222-8222-222222222221' AS UUID),
          CAST(${author.userId} AS UUID),
          CAST(${secondVideo.id} AS UUID),
          CAST(${activeRoot.id} AS UUID),
          CAST(${activeRoot.id} AS UUID),
          'Corrupt cross-video reply beneath the active root.'
        ),
        (
          CAST('22222222-2222-4222-8222-222222222222' AS UUID),
          CAST(${author.userId} AS UUID),
          CAST(${secondVideo.id} AS UUID),
          CAST(${deletedRoot.id} AS UUID),
          CAST(${deletedRoot.id} AS UUID),
          'Corrupt cross-video reply beneath the deleted root.'
        )
    `;
    await runtime.videosService.deleteVideoComment({
      publicId: firstVideo.publicId,
      commentId: deletedRoot.id,
      userId: author.userId,
      actorRole: 'user',
    });

    await expect(
      runtime.prisma.comment.count({
        where: {
          videoId: secondVideo.id,
          rootId: { in: [activeRoot.id, deletedRoot.id] },
        },
      }),
    ).resolves.toBe(2);

    const rootsResponse = await request(app)
      .get(`/videos/${firstVideo.publicId}/comments`)
      .expect(200);
    expect(rootsResponse.body.total).toBe(1);
    expect(rootsResponse.body.comments).toEqual([
      expect.objectContaining({
        id: activeRoot.id,
        replyCount: 0,
      }),
    ]);
    expect(rootsResponse.body.comments.map(({ id }: { id: string }) => id)).not.toContain(
      deletedRoot.id,
    );

    const repliesResponse = await request(app)
      .get(`/videos/${firstVideo.publicId}/comments/${activeRoot.id}/replies`)
      .expect(200);
    expect(repliesResponse.body).toEqual({ replies: [], total: 0, nextCursor: null });
  });

  test('degrades cross-video and cross-thread reply targets to an absent target', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-target-guard-owner@example.com',
      username: 'target_guard_owner',
    });
    const rootAuthor = await createVerifiedSession(runtime, {
      email: 'comment-target-root@example.com',
      username: 'target_root_author',
    });
    const replier = await createVerifiedSession(runtime, {
      email: 'comment-target-replier@example.com',
      username: 'target_guard_reply',
    });
    const otherThreadUsername = 'target_thread_author';
    const otherThreadAuthor = await createVerifiedSession(runtime, {
      email: 'comment-target-thread@example.com',
      username: otherThreadUsername,
    });
    const otherVideoUsername = 'target_video_author';
    const otherVideoAuthor = await createVerifiedSession(runtime, {
      email: 'comment-target-video@example.com',
      username: otherVideoUsername,
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Defensive reply target projection',
      visibility: 'public',
    });
    const otherVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Foreign reply target video',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: rootAuthor.userId,
        content: 'The legitimate root.',
      })
    ).comment;
    const otherThreadRoot = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: otherThreadAuthor.userId,
        content: 'Foreign thread target content.',
      })
    ).comment;
    const otherVideoRoot = (
      await runtime.videosService.createVideoComment({
        publicId: otherVideo.publicId,
        userId: otherVideoAuthor.userId,
        content: 'Foreign video target content.',
      })
    ).comment;
    const crossThreadReplyId = '33333333-3333-4333-8333-333333333331';
    const crossVideoReplyId = '33333333-3333-4333-8333-333333333332';

    await runtime.prisma.$executeRaw`
      INSERT INTO "comments" (
        "id",
        "author_id",
        "video_id",
        "root_id",
        "replying_to_comment_id",
        "content"
      )
      VALUES
        (
          CAST(${crossThreadReplyId} AS UUID),
          CAST(${replier.userId} AS UUID),
          CAST(${video.id} AS UUID),
          CAST(${root.id} AS UUID),
          CAST(${otherThreadRoot.id} AS UUID),
          'A correctly placed reply with a foreign thread target.'
        ),
        (
          CAST(${crossVideoReplyId} AS UUID),
          CAST(${replier.userId} AS UUID),
          CAST(${video.id} AS UUID),
          CAST(${root.id} AS UUID),
          CAST(${otherVideoRoot.id} AS UUID),
          'A correctly placed reply with a foreign video target.'
        )
    `;

    const response = await request(app)
      .get(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .expect(200);
    const repliesById = new Map(
      response.body.replies.map((reply: { id: string; replyingTo: unknown }) => [reply.id, reply]),
    );

    expect(response.body.total).toBe(2);
    expect(repliesById.get(crossThreadReplyId)).toMatchObject({ replyingTo: null });
    expect(repliesById.get(crossVideoReplyId)).toMatchObject({ replyingTo: null });
    expect(JSON.stringify(response.body)).not.toContain(otherThreadRoot.id);
    expect(JSON.stringify(response.body)).not.toContain(otherVideoRoot.id);
    expect(JSON.stringify(response.body)).not.toContain(otherThreadUsername);
    expect(JSON.stringify(response.body)).not.toContain(otherVideoUsername);
    expect(JSON.stringify(response.body)).not.toContain('Foreign thread target content.');
    expect(JSON.stringify(response.body)).not.toContain('Foreign video target content.');
  });

  test('exports active comments and soft-deleted tombstones still attributed to the user', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-export-owner@example.com',
      username: 'comment_export_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-export-author@example.com',
      username: 'c_export_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment personal data export',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Root included in my personal export.',
      })
    ).comment;
    const reply = (
      await runtime.videosService.createVideoCommentReply({
        publicId: video.publicId,
        rootCommentId: root.id,
        replyingToCommentId: root.id,
        userId: author.userId,
        content: 'Reply included with its root identifier.',
      })
    ).comment;
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${root.id}`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .expect(204);

    const dataExport = await request(app)
      .post('/auth/me/export')
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .send({ currentPassword: INITIAL_PASSWORD })
      .expect(200);

    expect(dataExport.body.comments).toEqual(
      expect.arrayContaining([
        {
          id: root.id,
          videoId: video.id,
          content: null,
          createdAt: expect.any(String),
          deletedAt: expect.any(String),
          rootId: null,
          replyingToCommentId: null,
        },
        {
          id: reply.id,
          videoId: video.id,
          content: 'Reply included with its root identifier.',
          createdAt: expect.any(String),
          deletedAt: null,
          rootId: root.id,
          replyingToCommentId: root.id,
        },
      ]),
    );
    expect(dataExport.body.comments).toHaveLength(2);
  });

  test('serves a 2,500-comment personal export over chunked HTTP', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'large-comment-export-owner@example.com',
      username: 'large_export_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'large-comment-export-author@example.com',
      username: 'large_export_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Large comment personal data export',
      visibility: 'public',
    });
    const commentCount = 2_500;

    await runtime.prisma.$transaction([
      runtime.prisma.comment.createMany({
        data: Array.from({ length: commentCount }, (_, index) => ({
          id: randomUUID(),
          authorId: author.userId,
          videoId: video.id,
          content: `Exported comment ${index}`,
        })),
      }),
      runtime.prisma.video.update({
        where: { id: video.id },
        data: { commentCount },
      }),
    ]);

    const dataExport = await request(app)
      .post('/auth/me/export')
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .send({ currentPassword: INITIAL_PASSWORD })
      .expect(200);

    expect(dataExport.headers['content-length']).toBeUndefined();
    expect(dataExport.headers['transfer-encoding']).toBe('chunked');
    expect(dataExport.body.comments).toHaveLength(commentCount);
    expect(dataExport.body.comments[0]).toEqual(
      expect.objectContaining({
        videoId: video.id,
        content: expect.stringMatching(/^Exported comment \d+$/),
      }),
    );
  });

  test('rejects a burst of random reply roots before opening any video-lock transaction', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'invalid-reply-root-owner@example.com',
      username: 'invalid_root_owner',
    });
    const replier = await createVerifiedSession(runtime, {
      email: 'invalid-reply-root-author@example.com',
      username: 'invalid_root_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Popular video protected from invalid reply contention',
      visibility: 'public',
    });
    let transactionCalls = 0;
    const observedPrisma = createBarrierPrisma(runtime.prisma, {
      onTransactionStart: () => {
        transactionCalls += 1;
      },
    });
    const observedService = createIntegrationVideosService(
      observedPrisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const app = await createIntegrationApp(runtime, {
      videosService: observedService,
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app)
          .post(`/videos/${video.publicId}/comments/${randomUUID()}/replies`)
          .set('Authorization', `Bearer ${replier.sessionKey}`)
          .send({ content: 'This random root must fail before the video lock.' }),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual(Array(20).fill(404));
    expect(transactionCalls).toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
  });

  test('rejects invalid or foreign reply targets before opening any video-lock transaction', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'invalid-reply-target-owner@example.com',
      username: 'target_owner',
    });
    const replier = await createVerifiedSession(runtime, {
      email: 'invalid-reply-target-author@example.com',
      username: 'target_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Popular video protected from invalid reply target contention',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: replier.userId,
        content: 'A valid root must not make invalid targets expensive.',
      })
    ).comment;
    const otherVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Foreign reply target video',
      visibility: 'public',
    });
    const foreignRoot = (
      await runtime.videosService.createVideoComment({
        publicId: otherVideo.publicId,
        userId: replier.userId,
        content: 'This root belongs to another video.',
      })
    ).comment;
    let transactionCalls = 0;
    const observedPrisma = createBarrierPrisma(runtime.prisma, {
      onTransactionStart: () => {
        transactionCalls += 1;
      },
    });
    const observedService = createIntegrationVideosService(
      observedPrisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const app = await createIntegrationApp(runtime, {
      videosService: observedService,
    });
    const invalidTargetIds = [...Array.from({ length: 20 }, () => randomUUID()), foreignRoot.id];
    const responses = await Promise.all(
      invalidTargetIds.map((replyingToCommentId) =>
        request(app)
          .post(`/videos/${video.publicId}/comments/${root.id}/replies`)
          .set('Authorization', `Bearer ${replier.sessionKey}`)
          .send({
            content: 'This invalid target must fail before the video lock.',
            replyingToCommentId,
          }),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual(Array(invalidTargetIds.length).fill(404));
    expect(transactionCalls).toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 1 });
  });

  test('blocks creation when comments are disabled or the video is no longer engageable', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-scope-owner@example.com',
      username: 'scope_owner',
    });
    const commenter = await createVerifiedSession(runtime, {
      email: 'comment-scope-author@example.com',
      username: 'scope_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment engagement scope',
      visibility: 'public',
    });

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { allowComments: false },
    });
    await request(app)
      .post(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${commenter.sessionKey}`)
      .send({ content: 'Must be blocked while disabled.' })
      .expect(409);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: {
        allowComments: true,
        moderationStatus: 'rejected',
      },
    });
    await request(app)
      .post(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${commenter.sessionKey}`)
      .send({ content: 'Must be blocked after rejection.' })
      .expect(404);

    await expect(runtime.prisma.comment.count({ where: { videoId: video.id } })).resolves.toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
  });

  test('serializes comment creation with rejection in both video-lock orders', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-rejection-race-owner@example.com',
      username: 'comment_reject_owner',
    });
    const commenter = await createVerifiedSession(runtime, {
      email: 'comment-rejection-race-author@example.com',
      username: 'c_reject_author',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { role: 'moderator' },
    });
    const creationFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment creation locks before rejection',
      visibility: 'public',
    });
    const creationLocked = Promise.withResolvers<void>();
    const releaseCreation = Promise.withResolvers<void>();
    const creationFirstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            creationLocked.resolve();
            await releaseCreation.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const creationFirstApp = await createIntegrationApp(runtime, {
      videosService: creationFirstService,
    });
    const creationResponsePromise = request(creationFirstApp)
      .post(`/videos/${creationFirstVideo.publicId}/comments`)
      .set('Authorization', `Bearer ${commenter.sessionKey}`)
      .send({ content: 'Committed before the rejection.' })
      .then((response) => response);
    const [creationResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'comment creation to acquire the video lock',
      firstOperation: creationResponsePromise,
      firstPaused: creationLocked.promise,
      releaseFirst: releaseCreation.resolve,
      secondLockDescription: 'video rejection to wait for comment creation',
      startSecond: () =>
        activeRuntime.adminService.moderateVideo({
          actorUserId: owner.userId,
          videoId: creationFirstVideo.id,
          decision: 'rejected',
          reason: 'Concurrent rejection after the comment lock.',
        }),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(creationResponse.status).toBe(201);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: creationFirstVideo.id },
        select: { commentCount: true, moderationStatus: true },
      }),
    ).resolves.toEqual({ commentCount: 1, moderationStatus: 'rejected' });

    const rejectionFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Rejection locks before comment creation',
      visibility: 'public',
    });
    const rejectionLocked = Promise.withResolvers<void>();
    const releaseRejection = Promise.withResolvers<void>();
    const rejectionFirstService = createIntegrationAdminService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            rejectionLocked.resolve();
            await releaseRejection.promise;
          },
        },
      }),
      runtime.delivered,
    );
    const rejectionFirstApp = await createIntegrationApp(runtime);
    const rejectionFirstPromise = rejectionFirstService.moderateVideo({
      actorUserId: owner.userId,
      videoId: rejectionFirstVideo.id,
      decision: 'rejected',
      reason: 'Concurrent rejection before the comment lock.',
    });
    const [, rejectedCreationResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'video rejection to acquire the video lock',
      firstOperation: rejectionFirstPromise,
      firstPaused: rejectionLocked.promise,
      releaseFirst: releaseRejection.resolve,
      secondLockDescription: 'comment creation to wait for video rejection',
      startSecond: () =>
        request(rejectionFirstApp)
          .post(`/videos/${rejectionFirstVideo.publicId}/comments`)
          .set('Authorization', `Bearer ${commenter.sessionKey}`)
          .send({ content: 'Must not survive the rejection.' })
          .then((response) => response),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(rejectedCreationResponse.status).toBe(404);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: rejectionFirstVideo.id },
        select: { commentCount: true, moderationStatus: true },
      }),
    ).resolves.toEqual({ commentCount: 0, moderationStatus: 'rejected' });
    await expect(
      runtime.prisma.comment.count({ where: { videoId: rejectionFirstVideo.id } }),
    ).resolves.toBe(0);
  });

  test('keeps comment creation consistent across stale-candidate and already-rejected purges', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-purge-race-owner@example.com',
      username: 'comment_purge_owner',
    });
    const commenter = await createVerifiedSession(runtime, {
      email: 'comment-purge-race-author@example.com',
      username: 'comment_purge_author',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { role: 'moderator' },
    });
    const oldRejection = new Date('2026-07-01T00:00:00.000Z');
    const observedAt = new Date('2026-08-05T12:00:00.000Z');
    const rejectedBefore = new Date('2026-07-29T12:00:00.000Z');
    const creationFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment creation beats a stale purge snapshot',
      visibility: 'public',
    });
    await runtime.prisma.video.update({
      where: { id: creationFirstVideo.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt: oldRejection,
        visibility: 'unlisted',
      },
    });
    const creationLocked = Promise.withResolvers<void>();
    const releaseCreation = Promise.withResolvers<void>();
    const creationFirstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            creationLocked.resolve();
            await releaseCreation.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const creationFirstApp = await createIntegrationApp(runtime, {
      videosService: creationFirstService,
    });
    const candidatesRead = Promise.withResolvers<void>();
    const releaseCandidates = Promise.withResolvers<void>();
    const staleCandidatePurgeService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        afterVideoCandidates: async () => {
          candidatesRead.resolve();
          await releaseCandidates.promise;
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      { now: () => observedAt },
    );
    const staleCandidatePurgePromise = staleCandidatePurgeService.deleteExpiredVideosPendingPurge({
      observedAt,
      purgeBefore: rejectedBefore,
    });

    try {
      await waitForBarrier({
        description: 'the stale video-purge candidate snapshot',
        operations: [staleCandidatePurgePromise],
        signal: candidatesRead.promise,
      });
      await runtime.adminService.moderateVideo({
        actorUserId: owner.userId,
        videoId: creationFirstVideo.id,
        decision: 'approved',
      });
    } catch (error) {
      releaseCandidates.resolve();
      await Promise.allSettled([staleCandidatePurgePromise]);
      throw error;
    }
    const creationResponsePromise = request(creationFirstApp)
      .post(`/videos/${creationFirstVideo.publicId}/comments`)
      .set('Authorization', `Bearer ${commenter.sessionKey}`)
      .send({ content: 'Created before the stale purge recheck.' })
      .then((response) => response);
    const [creationResponse, stalePurgeResult] = await coordinateLockInterleaving({
      firstBarrierDescription: 'comment creation to acquire the video lock before stale purge',
      firstOperation: creationResponsePromise,
      firstPaused: creationLocked.promise,
      releaseFirst: () => {
        releaseCandidates.resolve();
        releaseCreation.resolve();
      },
      secondLockDescription: 'the stale purge recheck to wait for comment creation',
      startSecond: () => {
        releaseCandidates.resolve();
        return staleCandidatePurgePromise;
      },
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(creationResponse.status).toBe(201);
    expect(stalePurgeResult).toEqual({
      videosPendingPurgeDeleted: 0,
      videoPendingPurgeTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: creationFirstVideo.id },
        select: { commentCount: true, moderationStatus: true },
      }),
    ).resolves.toEqual({ commentCount: 1, moderationStatus: 'approved' });

    const purgeFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Deferred purge beats comment creation',
      visibility: 'public',
    });
    await runtime.prisma.video.update({
      where: { id: purgeFirstVideo.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt: oldRejection,
        visibility: 'unlisted',
      },
    });
    const purgeLocked = Promise.withResolvers<void>();
    const releasePurge = Promise.withResolvers<void>();
    const purgeFirstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            purgeLocked.resolve();
            await releasePurge.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
      { now: () => observedAt },
    );
    const purgeFirstApp = await createIntegrationApp(runtime);
    const purgeFirstPromise = purgeFirstService.deleteExpiredVideosPendingPurge({
      observedAt,
      purgeBefore: rejectedBefore,
    });
    const [purgeResult, purgedCreationResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'the deferred purge video lock',
      firstOperation: purgeFirstPromise,
      firstPaused: purgeLocked.promise,
      releaseFirst: releasePurge.resolve,
      runWhilePaused: () =>
        request(purgeFirstApp)
          .post(`/videos/${purgeFirstVideo.publicId}/comments`)
          .set('Authorization', `Bearer ${commenter.sessionKey}`)
          .send({ content: 'Must not survive the deferred purge.' })
          .then((response) => response),
      // The rejected row is already ineligible in this transaction's snapshot. The engagement
      // predicate belongs to the locking SELECT itself, so this 404 must complete while the purge
      // still owns the video lock instead of waiting for that lock to be released.
      whilePausedDescription: 'ineligible comment creation during the deferred purge lock',
    });

    expect(purgedCreationResponse.status).toBe(404);
    expect(purgeResult).toEqual({
      videosPendingPurgeDeleted: 1,
      videoPendingPurgeTargetsScheduled: expect.any(Number),
    });
    await expect(
      runtime.prisma.video.findUnique({ where: { id: purgeFirstVideo.id } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.comment.count({ where: { videoId: purgeFirstVideo.id } }),
    ).resolves.toBe(0);
  });

  test('returns one uniform 404 when a reply resource is absent or becomes ineligible', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'reply-not-found-owner@example.com',
      username: 'reply_nf_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'reply-not-found-author@example.com',
      username: 'reply_nf_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Uniform reply not found contract',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Remembered while the video was readable.',
      })
    ).comment;
    const expectedNotFound = {
      error: 'NotFound',
      message: 'Comment not found',
    };

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'failed' },
    });
    const inaccessibleKnownRoot = await request(await createIntegrationApp(runtime))
      .post(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .send({ content: 'This video is no longer eligible.' })
      .expect(404);
    const inaccessibleMissingRoot = await request(await createIntegrationApp(runtime))
      .post(`/videos/${video.publicId}/comments/${randomUUID()}/replies`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .send({ content: 'This root does not exist.' })
      .expect(404);

    expect(inaccessibleKnownRoot.body).toEqual(expectedNotFound);
    expect(inaccessibleMissingRoot.body).toEqual(expectedNotFound);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'ready' },
    });
    const candidatesRead = Promise.withResolvers<void>();
    const releaseCandidates = Promise.withResolvers<void>();
    const raceService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        afterCommentCandidates: async () => {
          candidatesRead.resolve();
          await releaseCandidates.promise;
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const raceApp = await createIntegrationApp(runtime, { videosService: raceService });
    const raceResponsePromise = request(raceApp)
      .post(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .send({ content: 'The status changes after preflight.' })
      .then((response) => response);
    const [raceResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'the reply-target preflight candidate read',
      firstOperation: raceResponsePromise,
      firstPaused: candidatesRead.promise,
      releaseFirst: releaseCandidates.resolve,
      runWhilePaused: () =>
        activeRuntime.prisma.video.update({
          where: { id: video.id },
          data: { processingStatus: 'failed' },
        }),
      whilePausedDescription: 'video ineligibility update after reply preflight',
    });

    expect(raceResponse.status).toBe(404);
    expect(raceResponse.body).toEqual(expectedNotFound);
    await expect(runtime.prisma.comment.count({ where: { rootId: root.id } })).resolves.toBe(0);
  });

  test('returns one uniform 404 when listing replies cannot resolve the requested thread', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'reply-list-not-found-owner@example.com',
      username: 'reply_list_nf_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'reply-list-not-found-author@example.com',
      username: 'reply_list_nf_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Reply list uniform not found contract',
      visibility: 'public',
    });
    const otherVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Wrong video for reply list root',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Root that belongs only to the first video.',
      })
    ).comment;
    const app = await createIntegrationApp(runtime);
    const missingRoot = await request(app)
      .get(`/videos/${video.publicId}/comments/${randomUUID()}/replies`)
      .expect(404)
      .expect('Cache-Control', 'no-store');
    const wrongVideo = await request(app)
      .get(`/videos/${otherVideo.publicId}/comments/${root.id}/replies`)
      .expect(404)
      .expect('Cache-Control', 'no-store');

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'failed' },
    });
    const unreadableVideo = await request(app)
      .get(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .expect(404)
      .expect('Cache-Control', 'no-store');
    const expectedNotFound = {
      error: 'NotFound',
      message: 'Comment not found',
    };

    expect(missingRoot.body).toEqual(expectedNotFound);
    expect(wrongVideo.body).toEqual(missingRoot.body);
    expect(unreadableVideo.body).toEqual(missingRoot.body);
  });

  test('paginates readable root threads and replies with stable cursors and grouped counts', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-list-owner@example.com',
      username: 'comment_list_owner',
    });
    const firstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-list-first@example.com',
      username: 'comment_list_first',
    });
    const secondAuthor = await createVerifiedSession(runtime, {
      email: 'comment-list-second@example.com',
      username: 'comment_list_second',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Paginated comment threads',
      visibility: 'public',
    });
    const roots = [];

    for (const [userId, content] of [
      [firstAuthor.userId, 'First root'],
      [secondAuthor.userId, 'Second root'],
      [firstAuthor.userId, 'Third root'],
    ] as const) {
      const result = await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId,
        content,
      });
      roots.push(result.comment);
    }

    const rootWithReplies = [...roots].sort((left, right) => right.id.localeCompare(left.id))[0];

    if (!rootWithReplies) {
      throw new Error('Expected a root comment');
    }

    const replies = [];

    for (const [userId, content] of [
      [secondAuthor.userId, 'First chronological reply'],
      [firstAuthor.userId, 'Second chronological reply'],
      [secondAuthor.userId, 'Third chronological reply'],
    ] as const) {
      const result = await runtime.videosService.createVideoCommentReply({
        publicId: video.publicId,
        userId,
        rootCommentId: rootWithReplies.id,
        content,
      });
      replies.push(result.comment);
    }

    const sharedCreatedAt = new Date('2026-08-05T10:00:00.000Z');
    await runtime.prisma.comment.updateMany({
      where: {
        id: {
          in: [...roots, ...replies].map(({ id }) => id),
        },
      },
      data: {
        createdAt: sharedCreatedAt,
      },
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: {
        allowComments: false,
        moderationStatus: 'rejected',
      },
    });

    const expectedRootIds = roots
      .map(({ id }) => id)
      .sort()
      .reverse();
    const firstPage = await request(app)
      .get(`/videos/${video.publicId}/comments`)
      .query({ limit: 2 })
      .expect(200)
      .expect('Cache-Control', 'no-store');

    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.comments.map(({ id }: { id: string }) => id)).toEqual(
      expectedRootIds.slice(0, 2),
    );
    expect(
      firstPage.body.comments.find(({ id }: { id: string }) => id === rootWithReplies.id)
        ?.replyCount,
    ).toBe(3);
    expect(firstPage.body.nextCursor).toEqual({
      id: expectedRootIds[1],
      createdAt: sharedCreatedAt.toISOString(),
    });

    const secondPage = await request(app)
      .get(`/videos/${video.publicId}/comments`)
      .query({
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorId: firstPage.body.nextCursor.id,
      })
      .expect(200);
    expect(secondPage.body.total).toBe(3);
    expect(secondPage.body.comments.map(({ id }: { id: string }) => id)).toEqual(
      expectedRootIds.slice(2),
    );
    expect(secondPage.body.nextCursor).toBeNull();

    const expectedReplyIds = replies.map(({ id }) => id).sort();
    const firstRepliesPage = await request(app)
      .get(`/videos/${video.publicId}/comments/${rootWithReplies.id}/replies`)
      .query({ limit: 2 })
      .expect(200);
    expect(firstRepliesPage.body.total).toBe(3);
    expect(firstRepliesPage.body.replies.map(({ id }: { id: string }) => id)).toEqual(
      expectedReplyIds.slice(0, 2),
    );

    const secondRepliesPage = await request(app)
      .get(`/videos/${video.publicId}/comments/${rootWithReplies.id}/replies`)
      .query({
        limit: 2,
        cursorCreatedAt: firstRepliesPage.body.nextCursor.createdAt,
        cursorId: firstRepliesPage.body.nextCursor.id,
      })
      .expect(200);
    expect(secondRepliesPage.body.replies.map(({ id }: { id: string }) => id)).toEqual(
      expectedReplyIds.slice(2),
    );

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'failed' },
    });
    await request(app).get(`/videos/${video.publicId}/comments`).expect(404);
    await request(app)
      .get(`/videos/${video.publicId}/comments/${rootWithReplies.id}/replies`)
      .expect(404);
  });

  test('executes emitted root and reply cursor queries with bounded index scans', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-cursor-plan-owner@example.com',
      username: 'cursor_plan_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-cursor-plan-author@example.com',
      username: 'cursor_plan_author',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment cursor execution plans',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Root for the cursor plan replies.',
      })
    ).comment;

    await runtime.prisma.$executeRaw`
      INSERT INTO "comments" (
        "id",
        "author_id",
        "video_id",
        "content",
        "created_at"
      )
      SELECT
        md5('cursor-plan-root-' || series."i"::text)::uuid,
        CAST(${author.userId} AS UUID),
        CAST(${video.id} AS UUID),
        'cursor-plan-root-' || series."i"::text,
        TIMESTAMP '2026-01-01 00:00:00' + series."i" * INTERVAL '1 millisecond'
      FROM generate_series(1, 20000) AS series("i")
    `;
    await runtime.prisma.$executeRaw`
      INSERT INTO "comments" (
        "id",
        "author_id",
        "video_id",
        "root_id",
        "replying_to_comment_id",
        "content",
        "created_at"
      )
      SELECT
        md5('cursor-plan-reply-' || series."i"::text)::uuid,
        CAST(${author.userId} AS UUID),
        CAST(${video.id} AS UUID),
        CAST(${root.id} AS UUID),
        CAST(${root.id} AS UUID),
        'cursor-plan-reply-' || series."i"::text,
        TIMESTAMP '2026-01-01 00:00:00' + series."i" * INTERVAL '1 millisecond'
      FROM generate_series(1, 20000) AS series("i")
    `;
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { commentCount: { increment: 40000 } },
    });
    await runtime.prisma.$executeRaw`ANALYZE "comments"`;

    const rootCursor = await runtime.prisma.comment.findFirst({
      where: {
        videoId: video.id,
        content: 'cursor-plan-root-19000',
      },
      select: {
        createdAt: true,
        id: true,
      },
    });
    const replyCursor = await runtime.prisma.comment.findFirst({
      where: {
        videoId: video.id,
        content: 'cursor-plan-reply-1000',
      },
      select: {
        createdAt: true,
        id: true,
      },
    });

    if (!rootCursor || !replyCursor) {
      throw new Error('Expected both cursor-plan boundary rows');
    }

    const emittedQueries: ObservedQuery[] = [];
    const observedPrisma = createQueryObservedPrismaClient(runtime.databaseUrl, (event) => {
      emittedQueries.push({ params: event.params, query: event.query });
    });
    let rootQuery: ObservedQuery;
    let replyQuery: ObservedQuery;

    try {
      await listVideoComments(
        { prisma: observedPrisma },
        {
          cursor: rootCursor,
          limit: 100,
          publicId: video.publicId,
        },
      );
      rootQuery = findEmittedCommentPageQuery(emittedQueries);

      emittedQueries.length = 0;
      await listVideoCommentReplies(
        { prisma: observedPrisma },
        {
          cursor: replyCursor,
          limit: 100,
          publicId: video.publicId,
          rootCommentId: root.id,
        },
      );
      replyQuery = findEmittedCommentPageQuery(emittedQueries);
    } finally {
      await observedPrisma.$disconnect();
    }

    const [rootPlan, replyPlan] = await Promise.all([
      explainObservedQuery(runtime.prisma, rootQuery),
      explainObservedQuery(runtime.prisma, replyQuery),
    ]);

    expectBoundedCommentCursorPlan(rootPlan);
    expectBoundedCommentCursorPlan(replyPlan);
  });

  test('soft-deletes author comments idempotently and projects placeholders only for live threads', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-delete-owner@example.com',
      username: 'c_delete_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-delete-author@example.com',
      username: 'c_delete_author',
    });
    const survivor = await createVerifiedSession(runtime, {
      email: 'comment-delete-survivor@example.com',
      username: 'c_delete_survivor',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment soft deletion',
      visibility: 'public',
    });
    const root = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Root that becomes a placeholder',
      })
    ).comment;
    const survivingReply = (
      await runtime.videosService.createVideoCommentReply({
        publicId: video.publicId,
        userId: survivor.userId,
        rootCommentId: root.id,
        content: 'This reply keeps the thread visible',
      })
    ).comment;
    const deletedReply = (
      await runtime.videosService.createVideoCommentReply({
        publicId: video.publicId,
        userId: author.userId,
        rootCommentId: root.id,
        content: 'This leaf must disappear',
      })
    ).comment;
    const standaloneRoot = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'This root must disappear',
      })
    ).comment;
    const otherRoot = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: survivor.userId,
        content: 'An active root',
      })
    ).comment;

    const concurrentDeletes = await Promise.all([
      request(app)
        .delete(`/videos/${video.publicId}/comments/${root.id}`)
        .set('Authorization', `Bearer ${author.sessionKey}`),
      request(app)
        .delete(`/videos/${video.publicId}/comments/${root.id}`)
        .set('Authorization', `Bearer ${author.sessionKey}`),
    ]);
    expect(concurrentDeletes.map(({ status }) => status)).toEqual([204, 204]);

    await request(app)
      .delete(`/videos/${video.publicId}/comments/${deletedReply.id}`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .expect(204);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${standaloneRoot.id}`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .expect(204);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${otherRoot.id}`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .expect(404);

    const rootRows = await runtime.prisma.comment.findMany({
      where: {
        id: {
          in: [root.id, deletedReply.id, standaloneRoot.id, otherRoot.id],
        },
      },
      select: {
        id: true,
        authorId: true,
        content: true,
        deletedAt: true,
        deletionOrigin: true,
      },
    });
    const rowsById = new Map(rootRows.map((row) => [row.id, row]));
    expect(rowsById.get(root.id)).toMatchObject({
      authorId: author.userId,
      content: null,
      deletedAt: expect.any(Date),
      deletionOrigin: 'author',
    });
    expect(rowsById.get(deletedReply.id)).toMatchObject({ content: null });
    expect(rowsById.get(standaloneRoot.id)).toMatchObject({ content: null });
    expect(rowsById.get(otherRoot.id)).toMatchObject({
      content: 'An active root',
      deletedAt: null,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 2 });

    const rootsResponse = await request(app).get(`/videos/${video.publicId}/comments`).expect(200);
    const placeholder = rootsResponse.body.comments.find(
      ({ id }: { id: string }) => id === root.id,
    );
    expect(placeholder).toEqual({
      id: root.id,
      content: null,
      isDeleted: true,
      createdAt: expect.any(String),
      rootCommentId: null,
      likeCount: 0,
      viewerHasLiked: false,
      replyingTo: null,
      author: null,
      replyCount: 1,
    });
    expect(rootsResponse.body.comments.map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining([root.id, otherRoot.id]),
    );
    expect(rootsResponse.body.comments.map(({ id }: { id: string }) => id)).not.toContain(
      standaloneRoot.id,
    );

    const repliesResponse = await request(app)
      .get(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .expect(200);
    expect(repliesResponse.body.replies.map(({ id }: { id: string }) => id)).toEqual([
      survivingReply.id,
    ]);
  });

  test('enforces the complete author, exact-owner, and moderation deletion matrix', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-permission-owner@example.com',
      username: 'c_perm_owner',
    });
    const otherVideoOwner = await createVerifiedSession(runtime, {
      email: 'comment-permission-other-owner@example.com',
      username: 'c_perm_other_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-permission-author@example.com',
      username: 'c_perm_author',
    });
    const thirdParty = await createVerifiedSession(runtime, {
      email: 'comment-permission-third@example.com',
      username: 'c_perm_third',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-permission-moderator@example.com',
      username: 'c_perm_moderator',
    });
    const admin = await createVerifiedSession(runtime, {
      email: 'comment-permission-admin@example.com',
      username: 'c_perm_admin',
    });
    await runtime.prisma.$transaction([
      runtime.prisma.user.update({
        where: { id: moderator.userId },
        data: { role: 'moderator' },
      }),
      runtime.prisma.user.update({
        where: { id: admin.userId },
        data: { role: 'admin' },
      }),
    ]);
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment permission matrix',
      visibility: 'public',
    });
    await createPlayableVideo(runtime, {
      ownerId: otherVideoOwner.userId,
      title: 'Other owner permission boundary',
      visibility: 'public',
    });
    const comments = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        runtime?.videosService.createVideoComment({
          publicId: video.publicId,
          userId: author.userId,
          content: `Permission matrix comment ${index}`,
        }),
      ),
    );
    const commentIds = comments.map((result) => {
      if (!result) {
        throw new Error('Comment creation unexpectedly lost the integration runtime');
      }

      return result.comment.id;
    });

    const deleteAs = (commentId: string, sessionKey: string) =>
      request(app)
        .delete(`/videos/${video.publicId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${sessionKey}`);

    await deleteAs(commentIds[0] ?? '', author.sessionKey).expect(204);
    await deleteAs(commentIds[1] ?? '', owner.sessionKey).expect(204);
    await deleteAs(commentIds[2] ?? '', otherVideoOwner.sessionKey).expect(404);
    await deleteAs(commentIds[3] ?? '', thirdParty.sessionKey).expect(404);
    await deleteAs(commentIds[4] ?? '', moderator.sessionKey).expect(204);
    await deleteAs(commentIds[5] ?? '', admin.sessionKey).expect(204);

    const rows = await runtime.prisma.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, deletedAt: true, deletionOrigin: true },
    });
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    expect(rowsById.get(commentIds[0] ?? '')).toMatchObject({
      deletedAt: expect.any(Date),
      deletionOrigin: 'author',
    });
    expect(rowsById.get(commentIds[1] ?? '')).toMatchObject({
      deletedAt: expect.any(Date),
      deletionOrigin: 'video_owner',
    });
    expect(rowsById.get(commentIds[2] ?? '')).toMatchObject({
      deletedAt: null,
      deletionOrigin: null,
    });
    expect(rowsById.get(commentIds[3] ?? '')).toMatchObject({
      deletedAt: null,
      deletionOrigin: null,
    });
    expect(rowsById.get(commentIds[4] ?? '')).toMatchObject({
      deletedAt: expect.any(Date),
      deletionOrigin: 'moderator',
    });
    expect(rowsById.get(commentIds[5] ?? '')).toMatchObject({
      deletedAt: expect.any(Date),
      deletionOrigin: 'admin',
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 2 });
  });

  test('rejects in-flight privileged deletion when the actor downgrade commits first', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-role-race-owner@example.com',
      username: 'c_role_race_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-role-race-author@example.com',
      username: 'c_role_race_author',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-role-race-moderator@example.com',
      username: 'c_role_race_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Privileged comment actor lock',
      visibility: 'public',
    });
    const comment = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'This comment must survive the actor downgrade race.',
      })
    ).comment;
    const downgrade = beginHeldActorDowngrade(runtime, moderator.userId, 'user');

    const [deletionResponse] = await coordinateGatedOperations({
      cleanup: [downgrade.disconnect],
      gateBarrierDescription: 'the uncommitted comment-moderator downgrade',
      gateOperation: downgrade.transaction,
      gatePaused: downgrade.paused,
      releaseGate: downgrade.release,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const deletionPromise = trackOperation(
          request(app)
            .delete(`/videos/${video.publicId}/comments/${comment.id}`)
            .set('Authorization', `Bearer ${moderator.sessionKey}`)
            .then((response) => response),
        );
        await waitForSignal({
          description: 'privileged comment deletion to wait on the actor row',
          observe: (signal) => waitForBlockedActorAuthorizationQuery(activeRuntime, signal),
        });

        return [deletionPromise] as const;
      },
    });

    expect(deletionResponse.status).toBe(404);
    expect(deletionResponse.body).toEqual({
      error: 'NotFound',
      message: 'Comment not found',
    });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: comment.id },
        select: {
          content: true,
          deletedAt: true,
          deletionOrigin: true,
        },
      }),
    ).resolves.toEqual({
      content: 'This comment must survive the actor downgrade race.',
      deletedAt: null,
      deletionOrigin: null,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 1 });
  });

  test('allows moderation deletion on rejected and non-ready videos', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-state-owner@example.com',
      username: 'c_state_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-state-author@example.com',
      username: 'c_state_author',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-state-moderator@example.com',
      username: 'c_state_moderator',
    });
    const admin = await createVerifiedSession(runtime, {
      email: 'comment-state-admin@example.com',
      username: 'c_state_admin',
    });
    await runtime.prisma.$transaction([
      runtime.prisma.user.update({
        where: { id: moderator.userId },
        data: { role: 'moderator' },
      }),
      runtime.prisma.user.update({
        where: { id: admin.userId },
        data: { role: 'admin' },
      }),
    ]);
    const rejectedVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Rejected video comment deletion',
      visibility: 'public',
    });
    const nonReadyVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Non-ready video comment deletion',
      visibility: 'public',
    });
    const rejectedComment = (
      await runtime.videosService.createVideoComment({
        publicId: rejectedVideo.publicId,
        userId: author.userId,
        content: 'Delete after rejection.',
      })
    ).comment;
    const nonReadyComment = (
      await runtime.videosService.createVideoComment({
        publicId: nonReadyVideo.publicId,
        userId: author.userId,
        content: 'Delete while processing.',
      })
    ).comment;
    await runtime.prisma.$transaction([
      runtime.prisma.video.update({
        where: { id: rejectedVideo.id },
        data: { moderationStatus: 'rejected', visibility: 'unlisted' },
      }),
      runtime.prisma.video.update({
        where: { id: nonReadyVideo.id },
        data: { processingStatus: 'processing' },
      }),
    ]);

    await request(app)
      .delete(`/videos/${rejectedVideo.publicId}/comments/${rejectedComment.id}`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(204);
    await request(app)
      .delete(`/videos/${nonReadyVideo.publicId}/comments/${nonReadyComment.id}`)
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .expect(204);

    await expect(
      runtime.prisma.comment.findMany({
        where: { id: { in: [rejectedComment.id, nonReadyComment.id] } },
        orderBy: { id: 'asc' },
        select: { deletionOrigin: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([{ deletionOrigin: 'moderator' }, { deletionOrigin: 'admin' }]),
    );
  });

  test('returns structurally identical 404 responses for absent, wrong-video, and unauthorized comments', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const firstOwner = await createVerifiedSession(runtime, {
      email: 'comment-uniform-first-owner@example.com',
      username: 'c_uniform_owner_a',
    });
    const secondOwner = await createVerifiedSession(runtime, {
      email: 'comment-uniform-second-owner@example.com',
      username: 'c_uniform_owner_b',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-uniform-author@example.com',
      username: 'c_uniform_author',
    });
    const unauthorized = await createVerifiedSession(runtime, {
      email: 'comment-uniform-third@example.com',
      username: 'c_uniform_third',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-uniform-moderator@example.com',
      username: 'c_uniform_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const firstVideo = await createPlayableVideo(runtime, {
      ownerId: firstOwner.userId,
      title: 'Uniform comment error first video',
      visibility: 'public',
    });
    const secondVideo = await createPlayableVideo(runtime, {
      ownerId: secondOwner.userId,
      title: 'Uniform comment error second video',
      visibility: 'public',
    });
    const comment = (
      await runtime.videosService.createVideoComment({
        publicId: firstVideo.publicId,
        userId: author.userId,
        content: 'This existence must not leak.',
      })
    ).comment;
    const authorization = `Bearer ${unauthorized.sessionKey}`;
    const absentCommentId = randomUUID();
    const [absent, wrongVideo, forbidden, otherOwnerForbidden, moderatorAbsent] = await Promise.all(
      [
        request(app)
          .delete(`/videos/${firstVideo.publicId}/comments/${absentCommentId}`)
          .set('Authorization', authorization),
        request(app)
          .delete(`/videos/${secondVideo.publicId}/comments/${comment.id}`)
          .set('Authorization', authorization),
        request(app)
          .delete(`/videos/${firstVideo.publicId}/comments/${comment.id}`)
          .set('Authorization', authorization),
        request(app)
          .delete(`/videos/${firstVideo.publicId}/comments/${comment.id}`)
          .set('Authorization', `Bearer ${secondOwner.sessionKey}`),
        request(app)
          .delete(`/videos/${firstVideo.publicId}/comments/${absentCommentId}`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`),
      ],
    );

    expect(absent.status).toBe(404);
    expect(wrongVideo.status).toBe(404);
    expect(forbidden.status).toBe(404);
    expect(otherOwnerForbidden.status).toBe(404);
    expect(moderatorAbsent.status).toBe(404);
    expect(wrongVideo.body).toEqual(absent.body);
    expect(forbidden.body).toEqual(absent.body);
    expect(otherOwnerForbidden.body).toEqual(forbidden.body);
    expect(moderatorAbsent.body).toEqual(absent.body);
    expect(absent.body).toEqual({ error: 'NotFound', message: 'Comment not found' });
  });

  test('uses the role loaded by current session validation, never a client role or login-time cache', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-session-role-owner@example.com',
      username: 'c_session_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-session-role-author@example.com',
      username: 'c_session_author',
    });
    const actor = await createVerifiedSession(runtime, {
      email: 'comment-session-role-actor@example.com',
      username: 'c_session_actor',
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Session role comment authorization',
      visibility: 'public',
    });
    const comments = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        runtime?.videosService.createVideoComment({
          publicId: video.publicId,
          userId: author.userId,
          content: `Session role comment ${index}`,
        }),
      ),
    );
    const commentIds = comments.map((result) => result?.comment.id ?? '');

    await request(app)
      .delete(`/videos/${video.publicId}/comments/${commentIds[0]}`)
      .set('Authorization', `Bearer ${actor.sessionKey}`)
      .set('X-User-Role', 'admin')
      .send({ actorRole: 'admin', role: 'admin' })
      .expect(404);

    await runtime.prisma.user.update({
      where: { id: actor.userId },
      data: { role: 'moderator' },
    });
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${commentIds[1]}`)
      .set('Authorization', `Bearer ${actor.sessionKey}`)
      .expect(204);

    await runtime.prisma.user.update({
      where: { id: actor.userId },
      data: { role: 'user' },
    });
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${commentIds[2]}`)
      .set('Authorization', `Bearer ${actor.sessionKey}`)
      .expect(404);
  });

  test('rejects a downgrade committed after session validation and before deletion', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-role-window-owner@example.com',
      username: 'c_role_window_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-role-window-author@example.com',
      username: 'c_role_window_author',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-role-window-moderator@example.com',
      username: 'c_role_window_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Session role downgrade window',
      visibility: 'public',
    });
    const comment = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'The current database role remains authoritative for this request.',
      })
    ).comment;
    const roleValidated = Promise.withResolvers<void>();
    const releaseValidatedRequest = Promise.withResolvers<void>();
    const baseAuthService = runtime.authService;
    const authService = {
      ...baseAuthService,
      validateSession: async (sessionKey: string) => {
        const result = await baseAuthService.validateSession(sessionKey);

        if (sessionKey === moderator.sessionKey) {
          roleValidated.resolve();
          await releaseValidatedRequest.promise;
        }

        return result;
      },
    };
    const app = await createIntegrationApp(runtime, { authService });
    const deletion = request(app)
      .delete(`/videos/${video.publicId}/comments/${comment.id}`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .then((response) => response);
    const [deletionResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'moderator session-role validation',
      firstOperation: deletion,
      firstPaused: roleValidated.promise,
      releaseFirst: releaseValidatedRequest.resolve,
      runWhilePaused: () =>
        activeRuntime.prisma.user.update({
          where: { id: moderator.userId },
          data: { role: 'user' },
        }),
      whilePausedDescription: 'moderator role downgrade after session validation',
    });

    expect(deletionResponse.status).toBe(404);
    await expect(
      runtime.prisma.user.findUniqueOrThrow({
        where: { id: moderator.userId },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: 'user' });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: comment.id },
        select: { content: true, deletedAt: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({
      content: 'The current database role remains authoritative for this request.',
      deletedAt: null,
      deletionOrigin: null,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 1 });
  });

  test('serializes author and moderator deletion through a real PostgreSQL video lock', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-dual-delete-owner@example.com',
      username: 'c_dual_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-dual-delete-author@example.com',
      username: 'c_dual_author',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-dual-delete-moderator@example.com',
      username: 'c_dual_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Concurrent authorized comment deletion',
      visibility: 'public',
    });
    const comment = (
      await runtime.videosService.createVideoComment({
        publicId: video.publicId,
        userId: author.userId,
        content: 'Only one authorized actor may win deletion.',
      })
    ).comment;
    const firstVideoLocked = Promise.withResolvers<void>();
    const releaseFirstDeletion = Promise.withResolvers<void>();
    const firstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            firstVideoLocked.resolve();
            await releaseFirstDeletion.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const firstApp = await createIntegrationApp(runtime, { videosService: firstService });
    const secondApp = await createIntegrationApp(runtime);
    const authorDeletion = request(firstApp)
      .delete(`/videos/${video.publicId}/comments/${comment.id}`)
      .set('Authorization', `Bearer ${author.sessionKey}`)
      .then((response) => response);
    const [authorDeletionResponse, moderatorDeletionResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'author deletion to acquire the video lock',
      firstOperation: authorDeletion,
      firstPaused: firstVideoLocked.promise,
      releaseFirst: releaseFirstDeletion.resolve,
      secondLockDescription: 'moderator deletion to wait for author deletion',
      startSecond: () =>
        request(secondApp)
          .delete(`/videos/${video.publicId}/comments/${comment.id}`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`)
          .then((response) => response),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(authorDeletionResponse.status).toBe(204);
    expect(moderatorDeletionResponse.status).toBe(204);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: comment.id },
        select: { deletionOrigin: true },
      }),
    ).resolves.toEqual({ deletionOrigin: 'author' });
  });

  test('serializes author comment deletion with account deletion in both video-lock orders', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-account-delete-race-owner@example.com',
      username: 'c_acct_del_owner',
    });
    const commentFirstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-delete-first-author@example.com',
      username: 'c_delete_first',
    });
    const commentFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Comment deletion locks before account deletion',
      visibility: 'public',
    });
    const commentFirstRoot = (
      await runtime.videosService.createVideoComment({
        publicId: commentFirstVideo.publicId,
        userId: commentFirstAuthor.userId,
        content: 'Deleted first through the comment route.',
      })
    ).comment;
    const commentDeletionLocked = Promise.withResolvers<void>();
    const releaseCommentDeletion = Promise.withResolvers<void>();
    const commentFirstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            commentDeletionLocked.resolve();
            await releaseCommentDeletion.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const commentFirstApp = await createIntegrationApp(runtime, {
      videosService: commentFirstService,
    });
    const accountAfterCommentService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const commentDeletionResponsePromise = request(commentFirstApp)
      .delete(`/videos/${commentFirstVideo.publicId}/comments/${commentFirstRoot.id}`)
      .set('Authorization', `Bearer ${commentFirstAuthor.sessionKey}`)
      .then((response) => response);
    const [commentDeletionResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'comment deletion to acquire the video lock',
      firstOperation: commentDeletionResponsePromise,
      firstPaused: commentDeletionLocked.promise,
      releaseFirst: releaseCommentDeletion.resolve,
      secondLockDescription: 'account deletion to wait for comment deletion',
      startSecond: () =>
        accountAfterCommentService.deleteAccount({
          userId: commentFirstAuthor.userId,
          currentPassword: INITIAL_PASSWORD,
        }),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(commentDeletionResponse.status).toBe(204);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: commentFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: commentFirstRoot.id },
        select: { authorId: true, content: true, deletedAt: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({
      authorId: null,
      content: null,
      deletedAt: expect.any(Date),
      deletionOrigin: 'author',
    });

    const accountFirstAuthor = await createVerifiedSession(runtime, {
      email: 'account-delete-first-author@example.com',
      username: 'c_account_first',
    });
    const accountFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account deletion locks before comment deletion',
      visibility: 'public',
    });
    const accountFirstRoot = (
      await runtime.videosService.createVideoComment({
        publicId: accountFirstVideo.publicId,
        userId: accountFirstAuthor.userId,
        content: 'Anonymized first through account deletion.',
      })
    ).comment;
    const accountVideoLocked = Promise.withResolvers<void>();
    const releaseAccountDeletion = Promise.withResolvers<void>();
    const accountFirstService = createIntegrationAuthService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            accountVideoLocked.resolve();
            await releaseAccountDeletion.promise;
          },
        },
      }),
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const accountFirstApp = await createIntegrationApp(runtime);
    const accountFirstPromise = accountFirstService.deleteAccount({
      userId: accountFirstAuthor.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    const [, commentAfterAccountResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'account deletion to acquire the video lock',
      firstOperation: accountFirstPromise,
      firstPaused: accountVideoLocked.promise,
      releaseFirst: releaseAccountDeletion.resolve,
      secondLockDescription: 'comment deletion to wait for account deletion',
      startSecond: () =>
        request(accountFirstApp)
          .delete(`/videos/${accountFirstVideo.publicId}/comments/${accountFirstRoot.id}`)
          .set('Authorization', `Bearer ${accountFirstAuthor.sessionKey}`)
          .then((response) => response),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(commentAfterAccountResponse.status).toBe(404);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: accountFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: accountFirstRoot.id },
        select: { authorId: true, content: true, deletedAt: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({
      authorId: null,
      content: null,
      deletedAt: expect.any(Date),
      deletionOrigin: 'account_deletion',
    });
  });

  test('serializes owner and moderator deletion with author account deletion in both lock orders', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-privileged-account-race-owner@example.com',
      username: 'c_priv_acct_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-privileged-account-race-moderator@example.com',
      username: 'c_priv_acct_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });

    const ownerFirstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-owner-first-account-author@example.com',
      username: 'c_owner_first_author',
    });
    const ownerFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Owner deletion locks before account deletion',
      visibility: 'public',
    });
    const ownerFirstComment = (
      await runtime.videosService.createVideoComment({
        publicId: ownerFirstVideo.publicId,
        userId: ownerFirstAuthor.userId,
        content: 'The video owner deletes this before account anonymization.',
      })
    ).comment;
    const ownerVideoLocked = Promise.withResolvers<void>();
    const releaseOwnerDeletion = Promise.withResolvers<void>();
    const ownerFirstVideosService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            ownerVideoLocked.resolve();
            await releaseOwnerDeletion.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const ownerFirstApp = await createIntegrationApp(runtime, {
      videosService: ownerFirstVideosService,
    });
    const accountAfterOwnerService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const ownerDeletion = request(ownerFirstApp)
      .delete(`/videos/${ownerFirstVideo.publicId}/comments/${ownerFirstComment.id}`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .then((response) => response);
    const [ownerDeletionResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'owner deletion to acquire the video lock',
      firstOperation: ownerDeletion,
      firstPaused: ownerVideoLocked.promise,
      releaseFirst: releaseOwnerDeletion.resolve,
      secondLockDescription: 'account deletion to wait for owner deletion',
      startSecond: () =>
        accountAfterOwnerService.deleteAccount({
          userId: ownerFirstAuthor.userId,
          currentPassword: INITIAL_PASSWORD,
        }),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(ownerDeletionResponse.status).toBe(204);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: ownerFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: ownerFirstComment.id },
        select: { authorId: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({ authorId: null, deletionOrigin: 'video_owner' });

    const accountFirstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-account-first-moderator-author@example.com',
      username: 'c_acct_mod_author',
    });
    const accountFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account deletion locks before moderator deletion',
      visibility: 'public',
    });
    const accountFirstComment = (
      await runtime.videosService.createVideoComment({
        publicId: accountFirstVideo.publicId,
        userId: accountFirstAuthor.userId,
        content: 'Account anonymization wins before moderator deletion.',
      })
    ).comment;
    const accountVideoLocked = Promise.withResolvers<void>();
    const releaseAccountDeletion = Promise.withResolvers<void>();
    const accountFirstService = createIntegrationAuthService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            accountVideoLocked.resolve();
            await releaseAccountDeletion.promise;
          },
        },
      }),
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const moderatorApp = await createIntegrationApp(runtime);
    const accountFirst = accountFirstService.deleteAccount({
      userId: accountFirstAuthor.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    const [, moderatorDeletionResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'account deletion to acquire the video lock before moderation',
      firstOperation: accountFirst,
      firstPaused: accountVideoLocked.promise,
      releaseFirst: releaseAccountDeletion.resolve,
      secondLockDescription: 'moderator deletion to wait for account deletion',
      startSecond: () =>
        request(moderatorApp)
          .delete(`/videos/${accountFirstVideo.publicId}/comments/${accountFirstComment.id}`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`)
          .then((response) => response),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(moderatorDeletionResponse.status).toBe(204);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: accountFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: accountFirstComment.id },
        select: { authorId: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({ authorId: null, deletionOrigin: 'account_deletion' });
  });

  test('deleting a moderator account leaves comments they removed and their aggregates unchanged', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-moderator-account-owner@example.com',
      username: 'c_mod_account_owner',
    });
    const author = await createVerifiedSession(runtime, {
      email: 'comment-moderator-account-author@example.com',
      username: 'c_mod_account_author',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'comment-moderator-account-actor@example.com',
      username: 'c_mod_account_actor',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const videos = await Promise.all([
      createPlayableVideo(runtime, {
        ownerId: owner.userId,
        title: 'First moderator account deletion boundary',
        visibility: 'public',
      }),
      createPlayableVideo(runtime, {
        ownerId: owner.userId,
        title: 'Second moderator account deletion boundary',
        visibility: 'public',
      }),
    ]);
    const comments = await Promise.all(
      videos.map(({ publicId }, index) =>
        runtime?.videosService.createVideoComment({
          publicId,
          userId: author.userId,
          content: `Comment removed by the moderator before account deletion ${index}`,
        }),
      ),
    );
    const commentIds = comments.map((result) => {
      if (!result) {
        throw new Error('Comment creation unexpectedly lost the integration runtime');
      }

      return result.comment.id;
    });

    await Promise.all(
      videos.map(({ publicId }, index) =>
        request(app)
          .delete(`/videos/${publicId}/comments/${commentIds[index]}`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`)
          .expect(204),
      ),
    );

    const commentsBeforeAccountDeletion = await runtime.prisma.comment.findMany({
      where: { id: { in: commentIds } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        authorId: true,
        content: true,
        deletedAt: true,
        deletionOrigin: true,
      },
    });
    const videosBeforeAccountDeletion = await runtime.prisma.video.findMany({
      where: { id: { in: videos.map(({ id }) => id) } },
      orderBy: { id: 'asc' },
      select: { id: true, commentCount: true },
    });
    expect(commentsBeforeAccountDeletion).toHaveLength(2);
    expect(commentsBeforeAccountDeletion).toEqual(
      expect.arrayContaining(
        commentIds.map((id) => ({
          id,
          authorId: author.userId,
          content: null,
          deletedAt: expect.any(Date),
          deletionOrigin: 'moderator',
        })),
      ),
    );
    expect(videosBeforeAccountDeletion).toEqual(
      expect.arrayContaining(
        videos.map(({ id }) => ({
          id,
          commentCount: 0,
        })),
      ),
    );

    await runtime.authService.deleteAccount({
      userId: moderator.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    await expect(
      runtime.prisma.comment.findMany({
        where: { id: { in: commentIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          authorId: true,
          content: true,
          deletedAt: true,
          deletionOrigin: true,
        },
      }),
    ).resolves.toEqual(commentsBeforeAccountDeletion);
    await expect(
      runtime.prisma.video.findMany({
        where: { id: { in: videos.map(({ id }) => id) } },
        orderBy: { id: 'asc' },
        select: { id: true, commentCount: true },
      }),
    ).resolves.toEqual(videosBeforeAccountDeletion);
    await expect(
      runtime.prisma.user.findUnique({ where: { id: moderator.userId }, select: { id: true } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.user.findUnique({ where: { id: author.userId }, select: { id: true } }),
    ).resolves.toEqual({ id: author.userId });
  });

  test('orders targeted replies and target-author account deletion through the shared video lock', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'comment-reply-account-race-owner@example.com',
      username: 'c_reply_acct_owner',
    });
    const replier = await createVerifiedSession(runtime, {
      email: 'comment-reply-account-race-replier@example.com',
      username: 'c_reply_acct_replier',
    });
    const replyFirstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-reply-first-target@example.com',
      username: 'c_reply_first_target',
    });
    const replyFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Reply locks target before account deletion',
      visibility: 'public',
    });
    const replyFirstRoot = (
      await runtime.videosService.createVideoComment({
        publicId: replyFirstVideo.publicId,
        userId: replyFirstAuthor.userId,
        content: 'Root targeted before its author is deleted.',
      })
    ).comment;
    const replyTransactionPausedAfterRowLocks = Promise.withResolvers<void>();
    const releaseReply = Promise.withResolvers<void>();
    const replyFirstService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            replyTransactionPausedAfterRowLocks.resolve();
            await releaseReply.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const replyFirstApp = await createIntegrationApp(runtime, {
      videosService: replyFirstService,
    });
    const accountAfterReplyService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const replyFirstResponsePromise = request(replyFirstApp)
      .post(`/videos/${replyFirstVideo.publicId}/comments/${replyFirstRoot.id}/replies`)
      .set('Authorization', `Bearer ${replier.sessionKey}`)
      .send({
        content: 'The reply commits before target anonymization.',
        replyingToCommentId: replyFirstRoot.id,
      })
      .then((response) => response);
    const [replyFirstResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'targeted reply to acquire its video and comment locks',
      firstOperation: replyFirstResponsePromise,
      firstPaused: replyTransactionPausedAfterRowLocks.promise,
      releaseFirst: releaseReply.resolve,
      secondLockDescription: 'target-author account deletion to wait for the reply',
      startSecond: () =>
        accountAfterReplyService.deleteAccount({
          userId: replyFirstAuthor.userId,
          currentPassword: INITIAL_PASSWORD,
        }),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(replyFirstResponse.status).toBe(201);
    const committedReplyId = replyFirstResponse.body.comment.id as string;
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: replyFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 1 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: committedReplyId },
        select: { content: true, deletedAt: true, replyingToCommentId: true },
      }),
    ).resolves.toEqual({
      content: 'The reply commits before target anonymization.',
      deletedAt: null,
      replyingToCommentId: replyFirstRoot.id,
    });
    const visibleReplies = await request(replyFirstApp)
      .get(`/videos/${replyFirstVideo.publicId}/comments/${replyFirstRoot.id}/replies`)
      .expect(200);
    expect(visibleReplies.body.replies).toEqual([
      expect.objectContaining({
        id: committedReplyId,
        replyingTo: null,
      }),
    ]);

    const accountFirstAuthor = await createVerifiedSession(runtime, {
      email: 'comment-account-first-target@example.com',
      username: 'c_acct_first_target',
    });
    const accountFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account deletion locks target before reply',
      visibility: 'public',
    });
    const accountFirstRoot = (
      await runtime.videosService.createVideoComment({
        publicId: accountFirstVideo.publicId,
        userId: accountFirstAuthor.userId,
        content: 'Root anonymized before the reply can lock it.',
      })
    ).comment;
    const accountVideoLocked = Promise.withResolvers<void>();
    const releaseAccount = Promise.withResolvers<void>();
    const accountFirstService = createIntegrationAuthService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            accountVideoLocked.resolve();
            await releaseAccount.promise;
          },
        },
      }),
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const accountFirstApp = await createIntegrationApp(runtime);
    const accountFirstPromise = accountFirstService.deleteAccount({
      userId: accountFirstAuthor.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    const [, replyAfterAccountResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'target-author account deletion to acquire the video lock',
      firstOperation: accountFirstPromise,
      firstPaused: accountVideoLocked.promise,
      releaseFirst: releaseAccount.resolve,
      secondLockDescription: 'targeted reply to wait for account deletion',
      startSecond: () =>
        request(accountFirstApp)
          .post(`/videos/${accountFirstVideo.publicId}/comments/${accountFirstRoot.id}/replies`)
          .set('Authorization', `Bearer ${replier.sessionKey}`)
          .send({
            content: 'Must not target an anonymized root.',
            replyingToCommentId: accountFirstRoot.id,
          })
          .then((response) => response),
      waitForSecondLock: (signal) => waitForBlockedVideoQueries(activeRuntime, 1, 5_000, signal),
    });

    expect(replyAfterAccountResponse.status).toBe(404);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: accountFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.count({
        where: { videoId: accountFirstVideo.id, rootId: accountFirstRoot.id },
      }),
    ).resolves.toBe(0);
  });

  test("serializes account deletion with a user's first-ever comment in both snapshot orders", async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'first-comment-race-owner@example.com',
      username: 'first_comment_owner',
    });
    const accountSnapshotFirstAuthor = await createVerifiedSession(runtime, {
      email: 'account-snapshot-first@example.com',
      username: 'acct_snapshot_first',
    });
    const accountSnapshotFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account snapshot precedes first comment',
      visibility: 'public',
    });
    const accountSnapshotRead = Promise.withResolvers<void>();
    const releaseAccountSnapshot = Promise.withResolvers<void>();
    const accountSnapshotFirstService = createIntegrationAuthService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 2,
          after: async () => {
            accountSnapshotRead.resolve();
            await releaseAccountSnapshot.promise;
          },
        },
      }),
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const accountSnapshotFirstApp = await createIntegrationApp(runtime);
    const accountSnapshotFirstPromise = accountSnapshotFirstService.deleteAccount({
      userId: accountSnapshotFirstAuthor.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    const [, committedCommentResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'the account-deletion comment snapshot',
      firstOperation: accountSnapshotFirstPromise,
      firstPaused: accountSnapshotRead.promise,
      releaseFirst: releaseAccountSnapshot.resolve,
      runWhilePaused: () =>
        request(accountSnapshotFirstApp)
          .post(`/videos/${accountSnapshotFirstVideo.publicId}/comments`)
          .set('Authorization', `Bearer ${accountSnapshotFirstAuthor.sessionKey}`)
          .send({ content: 'The first comment commits after the account snapshot.' })
          .expect(201)
          .then((response) => response),
      whilePausedDescription: 'first comment creation after the account snapshot',
    });
    const committedCommentId = committedCommentResponse.body.comment.id as string;
    await expect(
      runtime.prisma.user.findUnique({ where: { id: accountSnapshotFirstAuthor.userId } }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: accountSnapshotFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: committedCommentId },
        select: { authorId: true, content: true, deletedAt: true, deletionOrigin: true },
      }),
    ).resolves.toEqual({
      authorId: null,
      content: null,
      deletedAt: expect.any(Date),
      deletionOrigin: 'account_deletion',
    });

    const commentLockFirstAuthor = await createVerifiedSession(runtime, {
      email: 'first-comment-lock-first@example.com',
      username: 'comment_lock_first',
    });
    const commentLockFirstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'First comment lock precedes account deletion',
      visibility: 'public',
    });
    const commentVideoLocked = Promise.withResolvers<void>();
    const releaseCommentTransaction = Promise.withResolvers<void>();
    const commentLockFirstVideosService = createIntegrationVideosService(
      createBarrierPrisma(runtime.prisma, {
        transactionRawBarrier: {
          call: 1,
          after: async () => {
            commentVideoLocked.resolve();
            await releaseCommentTransaction.promise;
          },
        },
      }),
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const commentLockFirstApp = await createIntegrationApp(runtime, {
      videosService: commentLockFirstVideosService,
    });
    const accountAfterCommentLockService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const commentAfterAccountPromise = request(commentLockFirstApp)
      .post(`/videos/${commentLockFirstVideo.publicId}/comments`)
      .set('Authorization', `Bearer ${commentLockFirstAuthor.sessionKey}`)
      .send({ content: 'Must not become an orphan after account deletion.' })
      .then((response) => response);
    const [commentAfterAccountResponse] = await coordinateWhilePaused({
      firstBarrierDescription: 'the first-comment video lock',
      firstOperation: commentAfterAccountPromise,
      firstPaused: commentVideoLocked.promise,
      releaseFirst: releaseCommentTransaction.resolve,
      runWhilePaused: () =>
        accountAfterCommentLockService.deleteAccount({
          userId: commentLockFirstAuthor.userId,
          currentPassword: INITIAL_PASSWORD,
        }),
      whilePausedDescription: 'account deletion during the first-comment video lock',
    });

    expect(commentAfterAccountResponse.status).toBe(404);
    await expect(
      runtime.prisma.comment.count({ where: { videoId: commentLockFirstVideo.id } }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: commentLockFirstVideo.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
  });

  test('anonymizes active comments and subtracts exact aggregates before account deletion', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'comment-account-owner@example.com',
      username: 'c_acct_owner',
    });
    const deletedAuthor = await createVerifiedSession(runtime, {
      email: 'comment-account-deleted@example.com',
      username: 'c_acct_deleted',
    });
    const survivor = await createVerifiedSession(runtime, {
      email: 'comment-account-survivor@example.com',
      username: 'c_acct_survivor',
    });
    const firstVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account deletion comment thread',
      visibility: 'public',
    });
    const secondVideo = await createPlayableVideo(runtime, {
      ownerId: owner.userId,
      title: 'Account deletion second video',
      visibility: 'public',
    });
    const deletedRoot = (
      await runtime.videosService.createVideoComment({
        publicId: firstVideo.publicId,
        userId: deletedAuthor.userId,
        content: 'Root authored by the deleted account',
      })
    ).comment;
    const survivingReply = (
      await runtime.videosService.createVideoCommentReply({
        publicId: firstVideo.publicId,
        userId: survivor.userId,
        rootCommentId: deletedRoot.id,
        content: 'Reply preserved after account deletion',
      })
    ).comment;
    const hiddenDeletedRoot = (
      await runtime.videosService.createVideoComment({
        publicId: secondVideo.publicId,
        userId: deletedAuthor.userId,
        content: 'Root with no surviving replies',
      })
    ).comment;
    const survivingRoot = (
      await runtime.videosService.createVideoComment({
        publicId: secondVideo.publicId,
        userId: survivor.userId,
        content: 'Root preserved on the second video',
      })
    ).comment;

    await runtime.authService.deleteAccount({
      userId: deletedAuthor.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    const anonymized = await runtime.prisma.comment.findMany({
      where: { id: { in: [deletedRoot.id, hiddenDeletedRoot.id] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        authorId: true,
        content: true,
        deletedAt: true,
        deletionOrigin: true,
      },
    });
    expect(anonymized).toHaveLength(2);
    expect(anonymized).toEqual(
      expect.arrayContaining([
        {
          id: deletedRoot.id,
          authorId: null,
          content: null,
          deletedAt: expect.any(Date),
          deletionOrigin: 'account_deletion',
        },
        {
          id: hiddenDeletedRoot.id,
          authorId: null,
          content: null,
          deletedAt: expect.any(Date),
          deletionOrigin: 'account_deletion',
        },
      ]),
    );
    await expect(
      runtime.prisma.video.findMany({
        where: { id: { in: [firstVideo.id, secondVideo.id] } },
        orderBy: { title: 'asc' },
        select: { commentCount: true },
      }),
    ).resolves.toEqual([{ commentCount: 1 }, { commentCount: 1 }]);

    const firstRoots = await request(app)
      .get(`/videos/${firstVideo.publicId}/comments`)
      .expect(200);
    expect(firstRoots.body.comments).toEqual([
      expect.objectContaining({
        id: deletedRoot.id,
        isDeleted: true,
        author: null,
        replyCount: 1,
      }),
    ]);
    const firstReplies = await request(app)
      .get(`/videos/${firstVideo.publicId}/comments/${deletedRoot.id}/replies`)
      .expect(200);
    expect(firstReplies.body.replies).toEqual([
      expect.objectContaining({
        id: survivingReply.id,
        replyingTo: null,
      }),
    ]);

    const secondRoots = await request(app)
      .get(`/videos/${secondVideo.publicId}/comments`)
      .expect(200);
    expect(secondRoots.body.comments.map(({ id }: { id: string }) => id)).toEqual([
      survivingRoot.id,
    ]);
  });
});
