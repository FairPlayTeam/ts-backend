import { Prisma, type CommentDeletionOrigin } from '@prisma/client';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import { isPrismaForeignKeyConstraintError } from '../../lib/prismaErrors.js';
import {
  profileAvatarMediaAssetsSelection,
  toProfileMediaUrl,
} from '../../services/userMedia/userMedia.profileAssets.js';
import {
  CommentNotFoundError,
  CommentsDisabledError,
  CommentsTemporarilyUnavailableError,
} from './errors.js';
import { VideoNotFoundError } from '../videos/shared/errors.js';
import type {
  ActiveComment,
  CreateCommentInput,
  CreateReplyInput,
  CreateCommentResult,
  DeleteCommentInput,
  ListRepliesInput,
  ListRepliesResult,
  ListCommentsInput,
  ListCommentsResult,
  MutateCommentLikeInput,
  CommentCursor,
  CommentReply,
  CommentRoot,
  CommentsPort,
} from './types.js';
import type { AuthRole } from '../auth/index.js';
import {
  readableVideoWhere,
  writableVideoEngagementWhere,
  WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL,
} from '../videos/shared/readability.js';
import type { CommentsDependencies } from './dependencies.js';
import { softDeleteLockedVideoComments } from './lifecycle.js';
import { lockUserAuthorizationState } from '../auth/authorization.js';

const VIDEO_COMMENT_TRANSACTION_MAX_ATTEMPTS = 10;
const DEFAULT_VIDEO_COMMENTS_LIMIT = 20;
const MAX_VIDEO_COMMENTS_LIMIT = 100;

const commentMutationSelect = {
  id: true,
  publicId: true,
  content: true,
  videoId: true,
  rootId: true,
  root: {
    select: {
      publicId: true,
    },
  },
  createdAt: true,
  likeCount: true,
  author: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: profileAvatarMediaAssetsSelection,
    },
  },
  replyingToComment: {
    select: {
      id: true,
      publicId: true,
      videoId: true,
      rootId: true,
      deletedAt: true,
      author: {
        select: {
          username: true,
        },
      },
    },
  },
} satisfies Prisma.CommentSelect;

type CommentMutationRecord = Prisma.CommentGetPayload<{
  select: typeof commentMutationSelect;
}>;

const commentListSelect = {
  id: true,
  publicId: true,
  content: true,
  videoId: true,
  rootId: true,
  root: {
    select: {
      publicId: true,
    },
  },
  createdAt: true,
  deletedAt: true,
  likeCount: true,
  author: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: profileAvatarMediaAssetsSelection,
    },
  },
  replyingToComment: {
    select: {
      id: true,
      publicId: true,
      videoId: true,
      rootId: true,
      deletedAt: true,
      author: {
        select: {
          username: true,
        },
      },
    },
  },
} satisfies Prisma.CommentSelect;

type CommentListRecord = Prisma.CommentGetPayload<{
  select: typeof commentListSelect;
}>;

type ReplyingCommentRecord = Pick<CommentListRecord, 'rootId' | 'videoId'> & {
  replyingToComment: CommentListRecord['replyingToComment'];
};

type LockedCommentableVideo = {
  id: string;
  allowComments: boolean;
};

type LockedComment = {
  id: string;
  videoId: string;
  rootId: string | null;
  deletedAt: Date | null;
};

type LockedDeletionVideo = {
  id: string;
  ownerId: string;
};

type LockedDeletableComment = {
  id: string;
  authorId: string | null;
  deletedAt: Date | null;
};

type LockedLikeableComment = {
  id: string;
  allowComments: boolean;
};

type LockedCommentLikeTarget = {
  id: string;
};

export const resolveCommentLikeMutation = (
  operation: 'like' | 'unlike',
  factExists: boolean,
): { changeFact: boolean; likeCountDelta: -1 | 0 | 1 } => {
  if (operation === 'like') {
    return factExists
      ? { changeFact: false, likeCountDelta: 0 }
      : { changeFact: true, likeCountDelta: 1 };
  }

  return factExists
    ? { changeFact: true, likeCountDelta: -1 }
    : { changeFact: false, likeCountDelta: 0 };
};

export const resolveCommentDeletionOrigin = ({
  actorRole,
  authorId,
  ownerId,
  userId,
}: {
  actorRole: AuthRole;
  authorId: string | null;
  ownerId: string;
  userId: string;
}): CommentDeletionOrigin | null => {
  if (authorId === userId) {
    return 'author';
  }

  if (ownerId === userId) {
    return 'video_owner';
  }

  if (actorRole === 'moderator') {
    return 'moderator';
  }

  if (actorRole === 'admin') {
    return 'admin';
  }

  return null;
};

const normalizeCommentsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_VIDEO_COMMENTS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_VIDEO_COMMENTS_LIMIT);
};

const commentCursorFilter = (
  cursor: CommentCursor | undefined,
  cursorInternalId: string | undefined,
  direction: 'asc' | 'desc',
): Prisma.CommentWhereInput => {
  if (!cursor || !cursorInternalId) {
    return {};
  }

  const operator = direction === 'asc' ? 'gt' : 'lt';
  const boundaryOperator = direction === 'asc' ? 'gte' : 'lte';

  return {
    AND: [
      { createdAt: { [boundaryOperator]: cursor.createdAt } },
      {
        OR: [
          { createdAt: { [operator]: cursor.createdAt } },
          {
            createdAt: cursor.createdAt,
            id: { [operator]: cursorInternalId },
          },
        ],
      },
    ],
  };
};

const nextCommentCursor = (
  comments: readonly CommentListRecord[],
  hasNextPage: boolean,
): CommentCursor | null => {
  const lastComment = comments.at(-1);

  return hasNextPage && lastComment
    ? { createdAt: lastComment.createdAt, id: lastComment.publicId }
    : null;
};

const findViewerLikedCommentIds = async (
  tx: Prisma.TransactionClient,
  viewerUserId: string | undefined,
  commentIds: readonly string[],
): Promise<Set<string>> => {
  if (!viewerUserId || commentIds.length === 0) {
    return new Set<string>();
  }

  const viewerLikes = await tx.commentLike.findMany({
    where: {
      userId: viewerUserId,
      commentId: {
        in: [...commentIds],
      },
    },
    select: {
      commentId: true,
    },
  });

  return new Set(viewerLikes.map(({ commentId }) => commentId));
};

const findReadableVideoId = async (
  tx: Prisma.TransactionClient,
  publicId: string,
): Promise<string> => {
  const video = await tx.video.findFirst({
    where: {
      publicId,
      ...readableVideoWhere,
    },
    select: {
      id: true,
    },
  });

  if (!video) {
    throw new VideoNotFoundError();
  }

  return video.id;
};

const lockCommentableVideo = async (
  tx: Prisma.TransactionClient,
  publicId: string,
): Promise<LockedCommentableVideo> => {
  // Prisma Client does not expose SELECT ... FOR UPDATE. This row is the protocol lock shared
  // with moderation, purge, account deletion, and every comment-count mutation.
  const [video] = await tx.$queryRaw<LockedCommentableVideo[]>(
    Prisma.sql`
      SELECT
        v."id"::text AS "id",
        v."allow_comments" AS "allowComments"
      FROM "videos" AS v
      WHERE v."public_id" = ${publicId}
        AND ${WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL}
      FOR UPDATE
    `,
  );

  if (!video) {
    throw new VideoNotFoundError();
  }

  if (!video.allowComments) {
    throw new CommentsDisabledError();
  }

  return video;
};

const toReplyingTo = ({
  replyingToComment,
  rootId,
  videoId,
}: ReplyingCommentRecord): ActiveComment['replyingTo'] => {
  const targetAuthor = replyingToComment?.author;
  const belongsToThread =
    rootId !== null &&
    replyingToComment?.videoId === videoId &&
    (replyingToComment.id === rootId || replyingToComment.rootId === rootId);

  if (!belongsToThread || replyingToComment.deletedAt !== null || !targetAuthor) {
    return null;
  }

  return {
    commentId: replyingToComment.id,
    publicCommentId: replyingToComment.publicId,
    username: targetAuthor.username,
  };
};

const toCommentResult = (comment: CommentMutationRecord): CreateCommentResult => {
  if (!comment.content || !comment.author) {
    throw new Error('New video comment violated its active-author invariant');
  }

  return {
    comment: {
      id: comment.id,
      publicId: comment.publicId,
      content: comment.content,
      isDeleted: false,
      createdAt: comment.createdAt,
      rootCommentId: comment.rootId,
      rootCommentPublicId: comment.root?.publicId ?? null,
      likeCount: comment.likeCount,
      viewerHasLiked: false,
      replyingTo: toReplyingTo(comment),
      author: {
        username: comment.author.username,
        displayName: comment.author.displayName,
        avatarUrl: toProfileMediaUrl(
          comment.author.username,
          'avatar',
          comment.author.mediaAssets[0],
        ),
      },
    },
  };
};

const toActiveComment = (comment: CommentListRecord, viewerHasLiked: boolean) => {
  if (comment.deletedAt || !comment.content || !comment.author) {
    throw new Error('Active video comment violated its lifecycle invariant');
  }

  return {
    id: comment.id,
    publicId: comment.publicId,
    content: comment.content,
    isDeleted: false as const,
    createdAt: comment.createdAt,
    rootCommentId: comment.rootId,
    rootCommentPublicId: comment.root?.publicId ?? null,
    likeCount: comment.likeCount,
    viewerHasLiked,
    replyingTo: toReplyingTo(comment),
    author: {
      username: comment.author.username,
      displayName: comment.author.displayName,
      avatarUrl: toProfileMediaUrl(
        comment.author.username,
        'avatar',
        comment.author.mediaAssets[0],
      ),
    },
  };
};

const toCommentRoot = (
  comment: CommentListRecord,
  replyCount: number,
  viewerHasLiked: boolean,
): CommentRoot => {
  if (comment.rootId !== null) {
    throw new Error('Root video comment unexpectedly references another root');
  }

  if (comment.deletedAt) {
    if (comment.content !== null || comment.likeCount !== 0 || viewerHasLiked || replyCount < 1) {
      throw new Error('Deleted video comment placeholder violated its visibility invariant');
    }

    return {
      id: comment.id,
      publicId: comment.publicId,
      content: null,
      isDeleted: true,
      createdAt: comment.createdAt,
      rootCommentId: null,
      rootCommentPublicId: null,
      likeCount: comment.likeCount,
      viewerHasLiked: false,
      replyingTo: null,
      author: null,
      replyCount,
    };
  }

  return {
    ...toActiveComment(comment, viewerHasLiked),
    rootCommentId: null,
    rootCommentPublicId: null,
    replyCount,
  };
};

const toCommentReply = (comment: CommentListRecord, viewerHasLiked: boolean): CommentReply => {
  if (comment.rootId === null || !comment.root) {
    throw new Error('Video comment reply is missing its root');
  }

  return {
    ...toActiveComment(comment, viewerHasLiked),
    rootCommentId: comment.rootId,
    rootCommentPublicId: comment.root.publicId,
  };
};

const createCommentRecord = async (
  tx: Prisma.TransactionClient,
  input: {
    authorId: string;
    content: string;
    rootId?: string;
    replyingToCommentId?: string;
    videoId: string;
  },
): Promise<CommentMutationRecord> => {
  const comment = await tx.comment.create({
    data: {
      authorId: input.authorId,
      content: input.content,
      videoId: input.videoId,
      ...(input.rootId === undefined ? {} : { rootId: input.rootId }),
      ...(input.replyingToCommentId === undefined
        ? {}
        : { replyingToCommentId: input.replyingToCommentId }),
    },
    select: commentMutationSelect,
  });

  await tx.video.update({
    where: { id: input.videoId },
    data: {
      commentCount: {
        increment: 1,
      },
    },
  });

  return comment;
};

const runCommentTransaction = async <T>(
  deps: Pick<CommentsDependencies, 'prisma'>,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  try {
    return await runSerializableTransaction(deps.prisma, callback, {
      maxAttempts: VIDEO_COMMENT_TRANSACTION_MAX_ATTEMPTS,
      retryDelayMs: getSerializableTransactionRetryDelayMs,
    });
  } catch (err) {
    if (isPrismaForeignKeyConstraintError(err)) {
      throw new VideoNotFoundError();
    }

    if (isSerializableTransactionConflictError(err)) {
      throw new CommentsTemporarilyUnavailableError({ cause: err });
    }

    throw err;
  }
};

export const createComment = (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { content, publicId, userId }: CreateCommentInput,
): Promise<CreateCommentResult> =>
  runCommentTransaction(deps, async (tx) => {
    const video = await lockCommentableVideo(tx, publicId);
    const comment = await createCommentRecord(tx, {
      authorId: userId,
      content,
      videoId: video.id,
    });

    return toCommentResult(comment);
  });

export const createReply = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { content, publicId, replyingToCommentId, rootCommentId, userId }: CreateReplyInput,
): Promise<CreateCommentResult> => {
  const targetId = replyingToCommentId ?? rootCommentId;
  const candidates = await deps.prisma.comment.findMany({
    where: {
      publicId: {
        in: [rootCommentId, targetId],
      },
      deletedAt: null,
      video: {
        publicId,
        ...writableVideoEngagementWhere,
      },
    },
    select: {
      id: true,
      publicId: true,
      rootId: true,
    },
  });
  const root = candidates.find(
    ({ publicId: candidatePublicId }) => candidatePublicId === rootCommentId,
  );
  const target = candidates.find(
    ({ publicId: candidatePublicId }) => candidatePublicId === targetId,
  );

  if (
    !root ||
    root.rootId !== null ||
    !target ||
    (target.id !== root.id && target.rootId !== root.id)
  ) {
    throw new CommentNotFoundError();
  }

  const rootInternalId = root.id;
  const targetInternalId = target.id;

  try {
    return await runCommentTransaction(deps, async (tx) => {
      const video = await lockCommentableVideo(tx, publicId);
      // Keep the root and addressed target stable through insertion. Prisma Client cannot express
      // these ordered pessimistic row locks, which are the established final-validation boundary.
      const lockedComments = await tx.$queryRaw<LockedComment[]>(
        Prisma.sql`
          SELECT
            c."id"::text AS "id",
            c."video_id"::text AS "videoId",
            c."root_id"::text AS "rootId",
            c."deleted_at" AS "deletedAt"
          FROM "comments" AS c
          WHERE c."id" IN (
            CAST(${rootInternalId} AS UUID),
            CAST(${targetInternalId} AS UUID)
          )
          ORDER BY c."id"
          FOR UPDATE
        `,
      );
      const root = lockedComments.find(({ id }) => id === rootInternalId);
      const target = lockedComments.find(({ id }) => id === targetInternalId);

      if (
        !root ||
        root.videoId !== video.id ||
        root.rootId !== null ||
        root.deletedAt !== null ||
        !target ||
        target.videoId !== video.id ||
        target.deletedAt !== null ||
        (target.id !== root.id && target.rootId !== root.id)
      ) {
        throw new CommentNotFoundError();
      }

      const comment = await createCommentRecord(tx, {
        authorId: userId,
        content,
        rootId: root.id,
        replyingToCommentId: target.id,
        videoId: video.id,
      });

      return toCommentResult(comment);
    });
  } catch (err) {
    if (err instanceof VideoNotFoundError) {
      throw new CommentNotFoundError();
    }

    throw err;
  }
};

const visibleRootWhere = (videoId: string): Prisma.CommentWhereInput => ({
  videoId,
  rootId: null,
  OR: [
    { deletedAt: null },
    {
      replies: {
        some: {
          // Same-video/thread membership is a cross-row invariant enforced by comment
          // mutations. Keep reads defensive against rows written outside that path, and
          // repeat the non-null shape so PostgreSQL can use the active-reply partial index.
          videoId,
          rootId: { not: null },
          deletedAt: null,
        },
      },
    },
  ],
});

export const listComments = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { cursor, limit, publicId, viewerUserId }: ListCommentsInput,
): Promise<ListCommentsResult> => {
  const pageSize = normalizeCommentsLimit(limit);

  return deps.prisma.$transaction(
    async (tx) => {
      const videoId = await findReadableVideoId(tx, publicId);
      const rootWhere = visibleRootWhere(videoId);
      const cursorComment = cursor
        ? await tx.comment.findFirst({
            where: { ...rootWhere, publicId: cursor.id },
            select: { id: true },
          })
        : null;

      if (cursor && !cursorComment) {
        throw new CommentNotFoundError();
      }

      const pageWhere = cursor
        ? ({
            AND: [rootWhere, commentCursorFilter(cursor, cursorComment?.id, 'desc')],
          } satisfies Prisma.CommentWhereInput)
        : rootWhere;
      const queriedRoots = await tx.comment.findMany({
        where: pageWhere,
        select: commentListSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      });
      const roots = queriedRoots.slice(0, pageSize);
      const rootIds = roots.map(({ id }) => id);
      const groupedReplyCounts =
        rootIds.length === 0
          ? []
          : await tx.comment.groupBy({
              by: ['rootId'],
              where: {
                videoId,
                rootId: {
                  in: rootIds,
                },
                deletedAt: null,
              },
              _count: {
                _all: true,
              },
            });
      const total = await tx.comment.count({ where: rootWhere });
      const likedCommentIds = await findViewerLikedCommentIds(tx, viewerUserId, rootIds);
      const replyCounts = new Map(
        groupedReplyCounts.map(({ _count, rootId }) => [rootId, _count._all]),
      );

      return {
        comments: roots.map((root) =>
          toCommentRoot(root, replyCounts.get(root.id) ?? 0, likedCommentIds.has(root.id)),
        ),
        total,
        nextCursor: nextCommentCursor(roots, queriedRoots.length > pageSize),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
};

export const listReplies = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { cursor, limit, publicId, rootCommentId, viewerUserId }: ListRepliesInput,
): Promise<ListRepliesResult> => {
  const pageSize = normalizeCommentsLimit(limit);

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const videoId = await findReadableVideoId(tx, publicId);
        const root = await tx.comment.findFirst({
          where: {
            publicId: rootCommentId,
            ...visibleRootWhere(videoId),
          },
          select: {
            id: true,
          },
        });

        if (!root) {
          throw new CommentNotFoundError();
        }

        const repliesWhere = {
          videoId,
          rootId: root.id,
          deletedAt: null,
        } satisfies Prisma.CommentWhereInput;
        const cursorComment = cursor
          ? await tx.comment.findFirst({
              where: { ...repliesWhere, publicId: cursor.id },
              select: { id: true },
            })
          : null;

        if (cursor && !cursorComment) {
          throw new CommentNotFoundError();
        }

        const pageWhere = cursor
          ? ({
              AND: [repliesWhere, commentCursorFilter(cursor, cursorComment?.id, 'asc')],
            } satisfies Prisma.CommentWhereInput)
          : repliesWhere;
        const queriedReplies = await tx.comment.findMany({
          where: pageWhere,
          select: commentListSelect,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: pageSize + 1,
        });
        const replies = queriedReplies.slice(0, pageSize);
        const total = await tx.comment.count({ where: repliesWhere });
        const likedCommentIds = await findViewerLikedCommentIds(
          tx,
          viewerUserId,
          replies.map(({ id }) => id),
        );

        return {
          replies: replies.map((reply) => toCommentReply(reply, likedCommentIds.has(reply.id))),
          total,
          nextCursor: nextCommentCursor(replies, queriedReplies.length > pageSize),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  } catch (err) {
    if (err instanceof VideoNotFoundError) {
      throw new CommentNotFoundError();
    }

    throw err;
  }
};

/**
 * Every present or future deletion permission must go through this soft-delete protocol.
 * A direct Prisma `comment.delete()` can cascade an entire reply subtree without applying the
 * matching transactional `Video.commentCount` decrement, leaving the aggregate corrupted.
 */
export const deleteComment = async (
  deps: Pick<CommentsDependencies, 'clock' | 'prisma'>,
  { actorRole, commentId, publicId, userId }: DeleteCommentInput,
): Promise<void> => {
  const candidate = await deps.prisma.comment.findFirst({
    where: {
      publicId: commentId,
      video: {
        publicId,
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

  if (
    !candidate ||
    resolveCommentDeletionOrigin({
      actorRole,
      authorId: candidate.authorId,
      ownerId: candidate.video.ownerId,
      userId,
    }) === null
  ) {
    throw new CommentNotFoundError();
  }

  await runCommentTransaction(deps, async (tx) => {
    // Every deletion permission follows the same video-first pessimistic lock protocol as every
    // mutation of commentCount. Prisma Client has no standard row-locking operation for this read.
    const [video] = await tx.$queryRaw<LockedDeletionVideo[]>(
      Prisma.sql`
        SELECT
          v."id"::text AS "id",
          v."owner_id"::text AS "ownerId"
        FROM "videos" AS v
        WHERE v."public_id" = ${publicId}
        FOR UPDATE
      `,
    );

    if (!video) {
      throw new CommentNotFoundError();
    }

    // Revalidate video membership, every permission, and lifecycle on locked rows. This explicit
    // row lock is the established final-authorization boundary and Prisma Client has no equivalent
    // standard read.
    const [comment] = await tx.$queryRaw<LockedDeletableComment[]>(
      Prisma.sql`
        SELECT
          c."id"::text AS "id",
          c."author_id"::text AS "authorId",
          c."deleted_at" AS "deletedAt"
        FROM "comments" AS c
        WHERE c."id" = CAST(${candidate.id} AS UUID)
          AND c."video_id" = CAST(${video.id} AS UUID)
        FOR UPDATE
      `,
    );

    let deletionOrigin = comment
      ? resolveCommentDeletionOrigin({
          actorRole,
          authorId: comment.authorId,
          ownerId: video.ownerId,
          userId,
        })
      : null;

    if (deletionOrigin === 'moderator' || deletionOrigin === 'admin') {
      const actor = await lockUserAuthorizationState(tx, userId);
      deletionOrigin = resolveCommentDeletionOrigin({
        actorRole: !actor || actor.isBanned ? 'user' : actor.role,
        authorId: comment?.authorId ?? null,
        ownerId: video.ownerId,
        userId,
      });
    }

    if (!comment || deletionOrigin === null) {
      throw new CommentNotFoundError();
    }

    if (comment.deletedAt) {
      return;
    }

    const deletedCount = await softDeleteLockedVideoComments(tx, {
      commentIds: [comment.id],
      deletedAt: deps.clock.now(),
      deletionOrigin,
    });

    if (deletedCount === 0) {
      return;
    }

    const decremented = await tx.video.updateMany({
      where: {
        id: video.id,
        commentCount: {
          gt: 0,
        },
      },
      data: {
        commentCount: {
          decrement: 1,
        },
      },
    });

    if (decremented.count !== 1) {
      throw new Error('Active video comment is missing from the denormalized aggregate');
    }
  });
};

const findLikeableCommentCandidate = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { commentId, publicId }: Pick<MutateCommentLikeInput, 'commentId' | 'publicId'>,
): Promise<{ allowComments: boolean; commentId: string }> => {
  const candidate = await deps.prisma.comment.findFirst({
    where: {
      publicId: commentId,
      deletedAt: null,
      video: {
        publicId,
        ...writableVideoEngagementWhere,
      },
    },
    select: {
      id: true,
      video: {
        select: {
          allowComments: true,
        },
      },
    },
  });

  if (!candidate) {
    throw new CommentNotFoundError();
  }

  return { commentId: candidate.id, ...candidate.video };
};

const lockLikeableComment = async (
  tx: Prisma.TransactionClient,
  publicId: string,
  commentId: string,
): Promise<LockedLikeableComment> => {
  // Likes mutate only a comment-owned aggregate. Locking the target comment preserves the
  // delete/like ordering without serializing unrelated comments from the same popular video.
  const [comment] = await tx.$queryRaw<LockedLikeableComment[]>(
    Prisma.sql`
      SELECT
        c."id"::text AS "id",
        v."allow_comments" AS "allowComments"
      FROM "comments" AS c
      INNER JOIN "videos" AS v ON v."id" = c."video_id"
      WHERE c."id" = CAST(${commentId} AS UUID)
        AND c."deleted_at" IS NULL
        AND v."public_id" = ${publicId}
        AND ${WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL}
      FOR UPDATE OF c
    `,
  );

  if (!comment) {
    throw new CommentNotFoundError();
  }

  if (!comment.allowComments) {
    throw new CommentsDisabledError();
  }

  return comment;
};

export const likeComment = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { commentId, publicId, userId }: MutateCommentLikeInput,
): Promise<void> => {
  const candidate = await findLikeableCommentCandidate(deps, { commentId, publicId });

  if (!candidate.allowComments) {
    throw new CommentsDisabledError();
  }

  try {
    await runCommentTransaction(deps, async (tx) => {
      const comment = await lockLikeableComment(tx, publicId, candidate.commentId);
      const currentLike = await tx.commentLike.findUnique({
        where: {
          userId_commentId: {
            userId,
            commentId: comment.id,
          },
        },
        select: {
          commentId: true,
        },
      });
      const mutation = resolveCommentLikeMutation('like', currentLike !== null);

      if (!mutation.changeFact) {
        return;
      }

      await tx.commentLike.create({
        data: {
          userId,
          commentId: comment.id,
        },
      });
      const incremented = await tx.comment.updateMany({
        where: {
          id: comment.id,
          deletedAt: null,
        },
        data: {
          likeCount: {
            increment: mutation.likeCountDelta,
          },
        },
      });

      if (incremented.count !== 1) {
        throw new Error('Inserted comment like is missing from its active comment aggregate');
      }
    });
  } catch (err) {
    if (err instanceof VideoNotFoundError) {
      throw new CommentNotFoundError();
    }

    throw err;
  }
};

export const unlikeComment = async (
  deps: Pick<CommentsDependencies, 'prisma'>,
  { commentId, publicId, userId }: MutateCommentLikeInput,
): Promise<void> => {
  const candidate = await deps.prisma.comment.findFirst({
    where: {
      publicId: commentId,
      video: {
        publicId,
      },
    },
    select: {
      id: true,
    },
  });

  if (!candidate) {
    return;
  }

  try {
    await runCommentTransaction(deps, async (tx) => {
      const [comment] = await tx.$queryRaw<LockedCommentLikeTarget[]>(
        Prisma.sql`
          SELECT c."id"::text AS "id"
          FROM "comments" AS c
          INNER JOIN "videos" AS v ON v."id" = c."video_id"
          WHERE c."id" = CAST(${candidate.id} AS UUID)
            AND v."public_id" = ${publicId}
          FOR UPDATE OF c
        `,
      );

      if (!comment) {
        return;
      }

      const currentLike = await tx.commentLike.findUnique({
        where: {
          userId_commentId: {
            userId,
            commentId: comment.id,
          },
        },
        select: {
          commentId: true,
        },
      });
      const mutation = resolveCommentLikeMutation('unlike', currentLike !== null);

      if (!mutation.changeFact) {
        return;
      }

      await tx.commentLike.delete({
        where: {
          userId_commentId: {
            userId,
            commentId: comment.id,
          },
        },
      });
      const decremented = await tx.comment.updateMany({
        where: {
          id: comment.id,
          likeCount: {
            gt: 0,
          },
        },
        data: {
          likeCount: {
            decrement: 1,
          },
        },
      });

      if (decremented.count !== 1) {
        throw new Error('Deleted comment like is missing from its comment aggregate');
      }
    });
  } catch (err) {
    if (err instanceof VideoNotFoundError) {
      return;
    }

    throw err;
  }
};

export const createCommentsService = (deps: CommentsDependencies): CommentsPort => ({
  createComment: (input) => createComment(deps, input),
  createReply: (input) => createReply(deps, input),
  listComments: (input) => listComments(deps, input),
  listReplies: (input) => listReplies(deps, input),
  deleteComment: (input) => deleteComment(deps, input),
  likeComment: (input) => likeComment(deps, input),
  unlikeComment: (input) => unlikeComment(deps, input),
});
