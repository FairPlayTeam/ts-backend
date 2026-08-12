import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  VideoCommentNotFoundError,
  VideoCommentsDisabledError,
} from '../../src/services/videos.errors.js';
import type { VideosService } from '../../src/services/videos.types.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import {
  createIntegrationApp,
  createIntegrationVideosService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const waitForBlockedCommentQuery = async (
  prisma: PrismaClient,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity] = await prisma.$queryRaw<Array<{ blockedCount: number }>>`
      SELECT count(*)::int AS "blockedCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "comments" AS c%'
    `;

    if ((activity?.blockedCount ?? 0) >= 1) {
      return;
    }

    await delay(25);
  }

  throw new Error('Timed out waiting for a PostgreSQL comment-row lock waiter');
};

const createCommentLockBarrierPrisma = (
  prisma: PrismaClient,
  afterLock: () => Promise<void>,
): PrismaClient => {
  let barrierUsed = false;

  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ): Promise<T> =>
          target.$transaction(async (tx) => {
            const barrierTx = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === '$queryRaw') {
                  return async <QueryResult>(query: Prisma.Sql): Promise<QueryResult> => {
                    const result = await tx.$queryRaw<QueryResult>(query);
                    const sql = query.strings.join('');

                    if (!barrierUsed && sql.includes('FROM "comments" AS c')) {
                      barrierUsed = true;
                      await afterLock();
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

            return run(barrierTx);
          }, options);
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const createUser = async (
  runtime: TestRuntime,
  label: string,
  role: UserRole = 'user',
): Promise<{ sessionKey: string; userId: string }> => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const session = await createVerifiedSession(runtime, {
    email: `${label}-${suffix}@example.com`,
    username: `${label.slice(0, 7)}_${suffix}`,
  });

  if (role !== 'user') {
    await runtime.prisma.user.update({
      where: { id: session.userId },
      data: { role },
    });
  }

  return session;
};

const createReadyVideo = async (
  runtime: TestRuntime,
  ownerId: string,
  overrides: {
    allowComments?: boolean;
    moderationStatus?: 'approved' | 'pending' | 'rejected';
    processingStatus?: 'draft' | 'ready';
  } = {},
) =>
  runtime.prisma.video.create({
    data: {
      publicId: `L${randomUUID().replaceAll('-', '').slice(0, 9)}`,
      ownerId,
      title: 'Comment like integration video',
      visibility: 'public',
      allowComments: overrides.allowComments ?? true,
      moderationStatus: overrides.moderationStatus ?? 'approved',
      processingStatus: overrides.processingStatus ?? 'ready',
      ...(overrides.processingStatus === 'draft' ? {} : { durationSeconds: 1 }),
    },
    select: {
      id: true,
      publicId: true,
    },
  });

const createComment = async (
  runtime: TestRuntime,
  video: { publicId: string },
  authorId: string,
  content = 'A comment that can receive likes.',
) =>
  (
    await runtime.videosService.createVideoComment({
      publicId: video.publicId,
      userId: authorId,
      content,
    })
  ).comment;

const withFirstCommentLockHeld = async (
  runtime: TestRuntime,
  first: (service: VideosService) => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> => {
  let releaseLock!: () => void;
  let reportLock!: () => void;
  const locked = new Promise<void>((resolve) => {
    reportLock = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const barrierPrisma = createCommentLockBarrierPrisma(runtime.prisma, async () => {
    reportLock();
    await release;
  });
  const barrierService = createIntegrationVideosService(
    barrierPrisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
  );
  const firstPromise = first(barrierService);

  await locked;

  const secondPromise = second();

  await waitForBlockedCommentQuery(runtime.prisma);
  releaseLock();

  return Promise.allSettled([firstPromise, secondPromise]);
};

describe('video comment likes integration', () => {
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

  test('enforces nonnegative comment like aggregates in PostgreSQL itself', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_check_owner');
    const video = await createReadyVideo(runtime, owner.userId);
    const comment = await createComment(runtime, video, owner.userId);

    await expect(
      runtime.prisma.comment.update({
        where: { id: comment.id },
        data: { likeCount: -1 },
      }),
    ).rejects.toThrow(/comments_like_count_nonnegative_check/);
  });

  test('serializes duplicate PUT, duplicate DELETE, PUT/DELETE, and distinct likers on the comment row', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_concurrency_owner');
    const firstUser = await createUser(runtime, 'like_concurrency_first');
    const secondUser = await createUser(runtime, 'like_concurrency_second');
    const video = await createReadyVideo(runtime, owner.userId);

    const duplicatePut = await createComment(runtime, video, owner.userId, 'Duplicate PUT');
    const duplicatePutResults = await withFirstCommentLockHeld(
      runtime,
      (service) =>
        service.likeVideoComment({
          publicId: video.publicId,
          commentId: duplicatePut.id,
          userId: firstUser.userId,
        }),
      () =>
        runtime!.videosService.likeVideoComment({
          publicId: video.publicId,
          commentId: duplicatePut.id,
          userId: firstUser.userId,
        }),
    );
    expect(duplicatePutResults.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: duplicatePut.id },
        select: { likeCount: true },
      }),
    ).resolves.toEqual({ likeCount: 1 });
    await expect(
      runtime.prisma.commentLike.count({ where: { commentId: duplicatePut.id } }),
    ).resolves.toBe(1);

    const distinctUsers = await createComment(runtime, video, owner.userId, 'Distinct users');
    const distinctResults = await withFirstCommentLockHeld(
      runtime,
      (service) =>
        service.likeVideoComment({
          publicId: video.publicId,
          commentId: distinctUsers.id,
          userId: firstUser.userId,
        }),
      () =>
        runtime!.videosService.likeVideoComment({
          publicId: video.publicId,
          commentId: distinctUsers.id,
          userId: secondUser.userId,
        }),
    );
    expect(distinctResults.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: distinctUsers.id },
        select: { likeCount: true },
      }),
    ).resolves.toEqual({ likeCount: 2 });

    const duplicateDelete = await createComment(runtime, video, owner.userId, 'Duplicate DELETE');
    await runtime.videosService.likeVideoComment({
      publicId: video.publicId,
      commentId: duplicateDelete.id,
      userId: firstUser.userId,
    });
    const duplicateDeleteResults = await withFirstCommentLockHeld(
      runtime,
      (service) =>
        service.unlikeVideoComment({
          publicId: video.publicId,
          commentId: duplicateDelete.id,
          userId: firstUser.userId,
        }),
      () =>
        runtime!.videosService.unlikeVideoComment({
          publicId: video.publicId,
          commentId: duplicateDelete.id,
          userId: firstUser.userId,
        }),
    );
    expect(duplicateDeleteResults.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: duplicateDelete.id },
        select: { likeCount: true },
      }),
    ).resolves.toEqual({ likeCount: 0 });

    const putThenDelete = await createComment(runtime, video, owner.userId, 'PUT then DELETE');
    const putDeleteResults = await withFirstCommentLockHeld(
      runtime,
      (service) =>
        service.likeVideoComment({
          publicId: video.publicId,
          commentId: putThenDelete.id,
          userId: firstUser.userId,
        }),
      () =>
        runtime!.videosService.unlikeVideoComment({
          publicId: video.publicId,
          commentId: putThenDelete.id,
          userId: firstUser.userId,
        }),
    );
    expect(putDeleteResults.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    await expect(
      Promise.all([
        runtime.prisma.comment.findUniqueOrThrow({
          where: { id: putThenDelete.id },
          select: { likeCount: true },
        }),
        runtime.prisma.commentLike.count({ where: { commentId: putThenDelete.id } }),
      ]),
    ).resolves.toEqual([{ likeCount: 0 }, 0]);
  });

  test('PUT uses strict engagement while DELETE remains an unconditional idempotent cleanup', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_scope_owner');
    const liker = await createUser(runtime, 'like_scope_liker');
    const video = await createReadyVideo(runtime, owner.userId);
    const comment = await createComment(runtime, video, owner.userId);
    const app = await createIntegrationApp(runtime);

    await runtime.videosService.likeVideoComment({
      publicId: video.publicId,
      commentId: comment.id,
      userId: liker.userId,
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { moderationStatus: 'rejected' },
    });

    await request(app)
      .put(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(404);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(204);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { moderationStatus: 'approved', allowComments: false },
    });
    await request(app)
      .put(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(409);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(204);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { allowComments: true },
    });
    await runtime.videosService.likeVideoComment({
      publicId: video.publicId,
      commentId: comment.id,
      userId: liker.userId,
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'draft' },
    });
    await request(app)
      .put(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(404);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(204);

    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { processingStatus: 'ready' },
    });
    await runtime.videosService.deleteVideoComment({
      publicId: video.publicId,
      commentId: comment.id,
      userId: owner.userId,
      actorRole: 'user',
    });
    await request(app)
      .put(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(404);
    await request(app)
      .delete(`/videos/${video.publicId}/comments/${comment.id}/like`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(204);
    await expect(
      runtime.prisma.comment.findUniqueOrThrow({
        where: { id: comment.id },
        select: { likeCount: true },
      }),
    ).resolves.toEqual({ likeCount: 0 });
    await expect(
      runtime.prisma.commentLike.count({ where: { commentId: comment.id } }),
    ).resolves.toBe(0);
  });

  test('returns one uniform PUT 404 and rejects invalid targets before opening a transaction', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_oracle_owner');
    const liker = await createUser(runtime, 'like_oracle_liker');
    const video = await createReadyVideo(runtime, owner.userId);
    const wrongVideo = await createReadyVideo(runtime, owner.userId);
    const rejectedVideo = await createReadyVideo(runtime, owner.userId);
    const disabledVideo = await createReadyVideo(runtime, owner.userId);
    const comment = await createComment(runtime, video, owner.userId);
    const deletedComment = await createComment(runtime, video, owner.userId, 'Deleted target');
    await runtime.videosService.deleteVideoComment({
      publicId: video.publicId,
      commentId: deletedComment.id,
      userId: owner.userId,
      actorRole: 'user',
    });
    const rejectedComment = await createComment(
      runtime,
      rejectedVideo,
      owner.userId,
      'Rejected target',
    );
    const disabledComment = await createComment(
      runtime,
      disabledVideo,
      owner.userId,
      'Disabled target',
    );
    await runtime.prisma.video.update({
      where: { id: rejectedVideo.id },
      data: { moderationStatus: 'rejected' },
    });
    await runtime.prisma.video.update({
      where: { id: disabledVideo.id },
      data: { allowComments: false },
    });
    const app = await createIntegrationApp(runtime);
    const targets = [
      `/videos/${video.publicId}/comments/${randomUUID()}/like`,
      `/videos/${wrongVideo.publicId}/comments/${comment.id}/like`,
      `/videos/${video.publicId}/comments/${deletedComment.id}/like`,
      `/videos/${rejectedVideo.publicId}/comments/${rejectedComment.id}/like`,
      `/videos/ZZZZZZZZZZ/comments/${comment.id}/like`,
    ];
    const responses = await Promise.all(
      targets.map((path) =>
        request(app).put(path).set('Authorization', `Bearer ${liker.sessionKey}`),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404, 404, 404]);
    expect(responses.map(({ body }) => body)).toEqual(
      Array.from({ length: 5 }, () => responses[0]!.body),
    );

    let transactionCalls = 0;
    const preflightPrisma = new Proxy(runtime.prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async () => {
            transactionCalls += 1;
            throw new Error('Invalid like targets must not open a transaction');
          };
        }

        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const preflightService = createIntegrationVideosService(
      preflightPrisma,
      runtime.videoObjectStorage,
      runtime.videoExternalResources,
    );
    const attempts = [
      ...Array.from({ length: 20 }, () => randomUUID()),
      deletedComment.id,
      rejectedComment.id,
    ];

    for (const commentId of attempts) {
      await expect(
        preflightService.likeVideoComment({
          publicId: commentId === rejectedComment.id ? rejectedVideo.publicId : video.publicId,
          commentId,
          userId: liker.userId,
        }),
      ).rejects.toBeInstanceOf(VideoCommentNotFoundError);
    }
    await expect(
      preflightService.likeVideoComment({
        publicId: disabledVideo.publicId,
        commentId: disabledComment.id,
        userId: liker.userId,
      }),
    ).rejects.toBeInstanceOf(VideoCommentsDisabledError);
    expect(transactionCalls).toBe(0);
  });

  test('projects likeCount and only the current viewer membership on root and reply DTOs', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_dto_owner');
    const liker = await createUser(runtime, 'like_dto_liker');
    const otherLiker = await createUser(runtime, 'like_dto_other');
    const video = await createReadyVideo(runtime, owner.userId);
    const root = await createComment(runtime, video, owner.userId);
    const reply = (
      await runtime.videosService.createVideoCommentReply({
        publicId: video.publicId,
        rootCommentId: root.id,
        userId: owner.userId,
        content: 'Reply with a like.',
      })
    ).comment;

    for (const userId of [liker.userId, otherLiker.userId]) {
      await runtime.videosService.likeVideoComment({
        publicId: video.publicId,
        commentId: root.id,
        userId,
      });
    }
    await runtime.videosService.likeVideoComment({
      publicId: video.publicId,
      commentId: reply.id,
      userId: liker.userId,
    });

    const app = await createIntegrationApp(runtime);
    const anonymousRoots = await request(app).get(`/videos/${video.publicId}/comments`).expect(200);
    const likedRoots = await request(app)
      .get(`/videos/${video.publicId}/comments`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(200);
    const likedReplies = await request(app)
      .get(`/videos/${video.publicId}/comments/${root.id}/replies`)
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .expect(200);

    expect(anonymousRoots.headers['cache-control']).toBe('no-store');
    expect(anonymousRoots.body.comments[0]).toMatchObject({
      id: root.id,
      likeCount: 2,
      viewerHasLiked: false,
    });
    expect(likedRoots.body.comments[0]).toMatchObject({
      id: root.id,
      likeCount: 2,
      viewerHasLiked: true,
    });
    expect(likedReplies.body.replies[0]).toMatchObject({
      id: reply.id,
      likeCount: 1,
      viewerHasLiked: true,
    });
    for (const body of [anonymousRoots.body, likedRoots.body, likedReplies.body]) {
      expect(JSON.stringify(body)).not.toContain(liker.userId);
      expect(JSON.stringify(body)).not.toContain(otherLiker.userId);
      expect(JSON.stringify(body)).not.toContain('likers');
    }
  });

  test.each([
    { actor: 'author', role: 'user' as const },
    { actor: 'owner', role: 'user' as const },
    { actor: 'moderator', role: 'moderator' as const },
    { actor: 'admin', role: 'admin' as const },
  ])(
    'serializes $actor deletion with a like in both comment-lock orders',
    async ({ actor, role }) => {
      if (!runtime) throw new Error('Integration runtime was not started');

      const owner = await createUser(runtime, `delete_like_owner_${actor}`);
      const author = await createUser(runtime, `delete_like_author_${actor}`);
      const liker = await createUser(runtime, `delete_like_liker_${actor}`);
      const privilegedActor =
        actor === 'author'
          ? author
          : actor === 'owner'
            ? owner
            : await createUser(runtime, `delete_like_actor_${actor}`, role);
      const video = await createReadyVideo(runtime, owner.userId);

      const likeFirst = await createComment(runtime, video, author.userId, `${actor}: like first`);
      const likeFirstResults = await withFirstCommentLockHeld(
        runtime,
        (service) =>
          service.likeVideoComment({
            publicId: video.publicId,
            commentId: likeFirst.id,
            userId: liker.userId,
          }),
        () =>
          runtime!.videosService.deleteVideoComment({
            publicId: video.publicId,
            commentId: likeFirst.id,
            userId: privilegedActor.userId,
            actorRole: role,
          }),
      );
      expect(likeFirstResults.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);

      const deleteFirst = await createComment(
        runtime,
        video,
        author.userId,
        `${actor}: delete first`,
      );
      const deleteFirstResults = await withFirstCommentLockHeld(
        runtime,
        (service) =>
          service.deleteVideoComment({
            publicId: video.publicId,
            commentId: deleteFirst.id,
            userId: privilegedActor.userId,
            actorRole: role,
          }),
        () =>
          runtime!.videosService.likeVideoComment({
            publicId: video.publicId,
            commentId: deleteFirst.id,
            userId: liker.userId,
          }),
      );
      expect(deleteFirstResults[0]?.status).toBe('fulfilled');
      expect(deleteFirstResults[1]?.status).toBe('rejected');
      expect(
        deleteFirstResults[1]?.status === 'rejected' ? deleteFirstResults[1].reason : null,
      ).toBeInstanceOf(VideoCommentNotFoundError);

      for (const commentId of [likeFirst.id, deleteFirst.id]) {
        await expect(
          runtime.prisma.comment.findUniqueOrThrow({
            where: { id: commentId },
            select: { deletedAt: true, likeCount: true },
          }),
        ).resolves.toEqual({ deletedAt: expect.any(Date), likeCount: 0 });
        await expect(runtime.prisma.commentLike.count({ where: { commentId } })).resolves.toBe(0);
      }
      await expect(
        runtime.prisma.video.findUniqueOrThrow({
          where: { id: video.id },
          select: { commentCount: true },
        }),
      ).resolves.toEqual({ commentCount: 0 });
    },
  );

  test('subtracts every emitted like exactly when the liker account is deleted', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'delete_liker_owner');
    const liker = await createUser(runtime, 'delete_liker');
    const survivor = await createUser(runtime, 'delete_liker_survivor');
    const firstVideo = await createReadyVideo(runtime, owner.userId);
    const secondVideo = await createReadyVideo(runtime, owner.userId);
    const comments = [
      await createComment(runtime, firstVideo, owner.userId, 'First liked comment'),
      await createComment(runtime, firstVideo, owner.userId, 'Second liked comment'),
      await createComment(runtime, secondVideo, owner.userId, 'Third liked comment'),
    ];

    for (const [index, comment] of comments.entries()) {
      const video = index < 2 ? firstVideo : secondVideo;
      await runtime.videosService.likeVideoComment({
        publicId: video.publicId,
        commentId: comment.id,
        userId: liker.userId,
      });
      await runtime.videosService.likeVideoComment({
        publicId: video.publicId,
        commentId: comment.id,
        userId: survivor.userId,
      });
    }

    await runtime.authService.deleteAccount({
      userId: liker.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    await expect(
      runtime.prisma.commentLike.count({ where: { userId: liker.userId } }),
    ).resolves.toBe(0);
    for (const comment of comments) {
      await expect(
        runtime.prisma.comment.findUniqueOrThrow({
          where: { id: comment.id },
          select: { likeCount: true },
        }),
      ).resolves.toEqual({ likeCount: 1 });
      await expect(
        runtime.prisma.commentLike.count({ where: { commentId: comment.id } }),
      ).resolves.toBe(1);
    }
  });

  test('soft-deletes authored comments and removes every received like during account deletion', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'delete_author_owner');
    const author = await createUser(runtime, 'delete_comment_author');
    const firstLiker = await createUser(runtime, 'delete_author_liker_one');
    const secondLiker = await createUser(runtime, 'delete_author_liker_two');
    const video = await createReadyVideo(runtime, owner.userId);
    const comments = [
      await createComment(runtime, video, author.userId, 'First authored comment'),
      await createComment(runtime, video, author.userId, 'Second authored comment'),
    ];

    for (const comment of comments) {
      for (const userId of [firstLiker.userId, secondLiker.userId]) {
        await runtime.videosService.likeVideoComment({
          publicId: video.publicId,
          commentId: comment.id,
          userId,
        });
      }
    }

    await runtime.authService.deleteAccount({
      userId: author.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    for (const comment of comments) {
      await expect(
        runtime.prisma.comment.findUniqueOrThrow({
          where: { id: comment.id },
          select: {
            authorId: true,
            content: true,
            deletedAt: true,
            deletionOrigin: true,
            likeCount: true,
          },
        }),
      ).resolves.toEqual({
        authorId: null,
        content: null,
        deletedAt: expect.any(Date),
        deletionOrigin: 'account_deletion',
        likeCount: 0,
      });
      await expect(
        runtime.prisma.commentLike.count({ where: { commentId: comment.id } }),
      ).resolves.toBe(0);
    }
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        select: { commentCount: true },
      }),
    ).resolves.toEqual({ commentCount: 0 });
  });

  test('streams personal comment likes with comment ids and creation timestamps', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'like_export_owner');
    const liker = await createUser(runtime, 'like_export_liker');
    const video = await createReadyVideo(runtime, owner.userId);
    const comments = [
      await createComment(runtime, video, owner.userId, 'First exported like'),
      await createComment(runtime, video, owner.userId, 'Second exported like'),
    ];

    for (const comment of comments) {
      await runtime.videosService.likeVideoComment({
        publicId: video.publicId,
        commentId: comment.id,
        userId: liker.userId,
      });
    }

    const app = await createIntegrationApp(runtime);
    const response = await request(app)
      .post('/auth/me/export')
      .set('Authorization', `Bearer ${liker.sessionKey}`)
      .send({ currentPassword: INITIAL_PASSWORD })
      .expect(200);

    expect(response.body.commentLikes).toHaveLength(2);
    expect(
      response.body.commentLikes.map(({ commentId }: { commentId: string }) => commentId).sort(),
    ).toEqual(comments.map(({ id }) => id).sort());
    for (const like of response.body.commentLikes as Array<{ createdAt: string }>) {
      expect(new Date(like.createdAt).toISOString()).toBe(like.createdAt);
    }
  });

  test('does not duplicate a like toggled after its first export page was emitted', async () => {
    if (!runtime) throw new Error('Integration runtime was not started');

    const owner = await createUser(runtime, 'paged_export_owner');
    const liker = await createUser(runtime, 'paged_export_liker');
    const video = await createReadyVideo(runtime, owner.userId);
    const exportedLikeCount = 251;

    await runtime.prisma.comment.createMany({
      data: Array.from({ length: exportedLikeCount }, (_, index) => ({
        authorId: owner.userId,
        videoId: video.id,
        content: `Paged exported like ${index}`,
      })),
    });
    const comments = await runtime.prisma.comment.findMany({
      where: { videoId: video.id },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await runtime.prisma.commentLike.createMany({
      data: comments.map(({ id }) => ({
        userId: liker.userId,
        commentId: id,
      })),
    });
    await runtime.prisma.comment.updateMany({
      where: { videoId: video.id },
      data: { likeCount: 1 },
    });
    await runtime.prisma.video.update({
      where: { id: video.id },
      data: { commentCount: exportedLikeCount },
    });
    const currentSession = await runtime.prisma.session.findFirstOrThrow({
      where: { userId: liker.userId },
      select: { id: true },
    });
    const exported = await runtime.authService.exportUserData({
      userId: liker.userId,
      currentSessionId: currentSession.id,
      currentPassword: INITIAL_PASSWORD,
    });
    const iterator = exported.commentLikes[Symbol.asyncIterator]();
    const firstPage: Array<{ commentId: string; createdAt: Date }> = [];

    for (let index = 0; index < 250; index += 1) {
      const item = await iterator.next();

      expect(item.done).toBe(false);
      if (!item.done) {
        firstPage.push(item.value);
      }
    }

    const toggledLike = firstPage[0];
    if (!toggledLike) {
      throw new Error('The first comment-like export page was unexpectedly empty');
    }

    await runtime.videosService.unlikeVideoComment({
      publicId: video.publicId,
      commentId: toggledLike.commentId,
      userId: liker.userId,
    });
    await runtime.videosService.likeVideoComment({
      publicId: video.publicId,
      commentId: toggledLike.commentId,
      userId: liker.userId,
    });

    const remaining: Array<{ commentId: string; createdAt: Date }> = [];
    for (let item = await iterator.next(); !item.done; item = await iterator.next()) {
      remaining.push(item.value);
    }

    const emitted = [...firstPage, ...remaining];
    expect(emitted).toHaveLength(exportedLikeCount);
    expect(new Set(emitted.map(({ commentId }) => commentId)).size).toBe(exportedLikeCount);
    expect(emitted.filter(({ commentId }) => commentId === toggledLike.commentId)).toHaveLength(1);
    expect(emitted.map(({ commentId }) => commentId)).toEqual(comments.map(({ id }) => id));
    await expect(
      runtime.prisma.commentLike.count({ where: { userId: liker.userId } }),
    ).resolves.toBe(exportedLikeCount);
  });
});
