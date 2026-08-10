import { Prisma, type CommentDeletionOrigin } from '@prisma/client';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import { isPrismaForeignKeyConstraintError } from '../auth/auth.prismaErrors.js';
import {
  profileMediaAssetSelect,
  toProfileMediaUrl,
} from '../userMedia/userMedia.profileAssets.js';
import {
  VideoCommentNotFoundError,
  VideoCommentsDisabledError,
  VideoCommentTemporarilyUnavailableError,
  VideoNotFoundError,
} from '../videos.errors.js';
import type {
  ActiveVideoComment,
  CreateVideoCommentInput,
  CreateVideoCommentReplyInput,
  CreateVideoCommentResult,
  DeleteVideoCommentInput,
  ListVideoCommentRepliesInput,
  ListVideoCommentRepliesResult,
  ListVideoCommentsInput,
  ListVideoCommentsResult,
  VideoCommentCursor,
  VideoCommentReply,
  VideoCommentRoot,
} from './types/ports.types.js';
import type { AuthRole } from '../auth.roles.js';
import {
  readableVideoWhere,
  writableVideoEngagementWhere,
  WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL,
} from './videoReadability.js';
import type { VideosDependencies } from './videos.dependencies.js';

const VIDEO_COMMENT_TRANSACTION_MAX_ATTEMPTS = 10;
const DEFAULT_VIDEO_COMMENTS_LIMIT = 20;
const MAX_VIDEO_COMMENTS_LIMIT = 100;

const commentMutationSelect = {
  id: true,
  content: true,
  videoId: true,
  rootId: true,
  createdAt: true,
  author: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: {
        where: {
          kind: 'avatar',
        },
        select: profileMediaAssetSelect,
        take: 1,
      },
    },
  },
  replyingToComment: {
    select: {
      id: true,
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
  content: true,
  videoId: true,
  rootId: true,
  createdAt: true,
  deletedAt: true,
  author: {
    select: {
      username: true,
      displayName: true,
      mediaAssets: {
        where: {
          kind: 'avatar',
        },
        select: profileMediaAssetSelect,
        take: 1,
      },
    },
  },
  replyingToComment: {
    select: {
      id: true,
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

export const resolveVideoCommentDeletionOrigin = ({
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

const normalizeVideoCommentsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_VIDEO_COMMENTS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_VIDEO_COMMENTS_LIMIT);
};

const commentCursorFilter = (
  cursor: VideoCommentCursor | undefined,
  direction: 'asc' | 'desc',
): Prisma.CommentWhereInput => {
  if (!cursor) {
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
            id: { [operator]: cursor.id },
          },
        ],
      },
    ],
  };
};

const nextCommentCursor = (
  comments: readonly CommentListRecord[],
  hasNextPage: boolean,
): VideoCommentCursor | null => {
  const lastComment = comments.at(-1);

  return hasNextPage && lastComment
    ? { createdAt: lastComment.createdAt, id: lastComment.id }
    : null;
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
    throw new VideoCommentsDisabledError();
  }

  return video;
};

const toReplyingTo = ({
  replyingToComment,
  rootId,
  videoId,
}: ReplyingCommentRecord): ActiveVideoComment['replyingTo'] => {
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
    username: targetAuthor.username,
  };
};

const toVideoCommentResult = (comment: CommentMutationRecord): CreateVideoCommentResult => {
  if (!comment.content || !comment.author) {
    throw new Error('New video comment violated its active-author invariant');
  }

  return {
    comment: {
      id: comment.id,
      content: comment.content,
      isDeleted: false,
      createdAt: comment.createdAt,
      rootCommentId: comment.rootId,
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

const toActiveVideoComment = (comment: CommentListRecord) => {
  if (comment.deletedAt || !comment.content || !comment.author) {
    throw new Error('Active video comment violated its lifecycle invariant');
  }

  return {
    id: comment.id,
    content: comment.content,
    isDeleted: false as const,
    createdAt: comment.createdAt,
    rootCommentId: comment.rootId,
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

const toVideoCommentRoot = (comment: CommentListRecord, replyCount: number): VideoCommentRoot => {
  if (comment.rootId !== null) {
    throw new Error('Root video comment unexpectedly references another root');
  }

  if (comment.deletedAt) {
    if (comment.content !== null || replyCount < 1) {
      throw new Error('Deleted video comment placeholder violated its visibility invariant');
    }

    return {
      id: comment.id,
      content: null,
      isDeleted: true,
      createdAt: comment.createdAt,
      rootCommentId: null,
      replyingTo: null,
      author: null,
      replyCount,
    };
  }

  return {
    ...toActiveVideoComment(comment),
    rootCommentId: null,
    replyCount,
  };
};

const toVideoCommentReply = (comment: CommentListRecord): VideoCommentReply => {
  if (comment.rootId === null) {
    throw new Error('Video comment reply is missing its root');
  }

  return {
    ...toActiveVideoComment(comment),
    rootCommentId: comment.rootId,
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

const runVideoCommentTransaction = async <T>(
  deps: Pick<VideosDependencies, 'prisma'>,
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
      throw new VideoCommentTemporarilyUnavailableError({ cause: err });
    }

    throw err;
  }
};

export const createVideoComment = (
  deps: Pick<VideosDependencies, 'prisma'>,
  { content, publicId, userId }: CreateVideoCommentInput,
): Promise<CreateVideoCommentResult> =>
  runVideoCommentTransaction(deps, async (tx) => {
    const video = await lockCommentableVideo(tx, publicId);
    const comment = await createCommentRecord(tx, {
      authorId: userId,
      content,
      videoId: video.id,
    });

    return toVideoCommentResult(comment);
  });

export const createVideoCommentReply = async (
  deps: Pick<VideosDependencies, 'prisma'>,
  { content, publicId, replyingToCommentId, rootCommentId, userId }: CreateVideoCommentReplyInput,
): Promise<CreateVideoCommentResult> => {
  const targetId = replyingToCommentId ?? rootCommentId;
  const candidates = await deps.prisma.comment.findMany({
    where: {
      id: {
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
      rootId: true,
    },
  });
  const root = candidates.find(({ id }) => id === rootCommentId);
  const target = candidates.find(({ id }) => id === targetId);

  if (
    !root ||
    root.rootId !== null ||
    !target ||
    (target.id !== root.id && target.rootId !== root.id)
  ) {
    throw new VideoCommentNotFoundError();
  }

  try {
    return await runVideoCommentTransaction(deps, async (tx) => {
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
            CAST(${rootCommentId} AS UUID),
            CAST(${targetId} AS UUID)
          )
          ORDER BY c."id"
          FOR UPDATE
        `,
      );
      const root = lockedComments.find(({ id }) => id === rootCommentId);
      const target = lockedComments.find(({ id }) => id === targetId);

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
        throw new VideoCommentNotFoundError();
      }

      const comment = await createCommentRecord(tx, {
        authorId: userId,
        content,
        rootId: root.id,
        replyingToCommentId: target.id,
        videoId: video.id,
      });

      return toVideoCommentResult(comment);
    });
  } catch (err) {
    if (err instanceof VideoNotFoundError) {
      throw new VideoCommentNotFoundError();
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

export const listVideoComments = async (
  deps: Pick<VideosDependencies, 'prisma'>,
  { cursor, limit, publicId }: ListVideoCommentsInput,
): Promise<ListVideoCommentsResult> => {
  const pageSize = normalizeVideoCommentsLimit(limit);

  return deps.prisma.$transaction(
    async (tx) => {
      const videoId = await findReadableVideoId(tx, publicId);
      const rootWhere = visibleRootWhere(videoId);
      const pageWhere = cursor
        ? ({
            AND: [rootWhere, commentCursorFilter(cursor, 'desc')],
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
      const replyCounts = new Map(
        groupedReplyCounts.map(({ _count, rootId }) => [rootId, _count._all]),
      );

      return {
        comments: roots.map((root) => toVideoCommentRoot(root, replyCounts.get(root.id) ?? 0)),
        total,
        nextCursor: nextCommentCursor(roots, queriedRoots.length > pageSize),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  );
};

export const listVideoCommentReplies = async (
  deps: Pick<VideosDependencies, 'prisma'>,
  { cursor, limit, publicId, rootCommentId }: ListVideoCommentRepliesInput,
): Promise<ListVideoCommentRepliesResult> => {
  const pageSize = normalizeVideoCommentsLimit(limit);

  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const videoId = await findReadableVideoId(tx, publicId);
        const root = await tx.comment.findFirst({
          where: {
            id: rootCommentId,
            ...visibleRootWhere(videoId),
          },
          select: {
            id: true,
          },
        });

        if (!root) {
          throw new VideoCommentNotFoundError();
        }

        const repliesWhere = {
          videoId,
          rootId: root.id,
          deletedAt: null,
        } satisfies Prisma.CommentWhereInput;
        const pageWhere = cursor
          ? ({
              AND: [repliesWhere, commentCursorFilter(cursor, 'asc')],
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

        return {
          replies: replies.map(toVideoCommentReply),
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
      throw new VideoCommentNotFoundError();
    }

    throw err;
  }
};

/**
 * Every present or future deletion permission must go through this soft-delete protocol.
 * A direct Prisma `comment.delete()` can cascade an entire reply subtree without applying the
 * matching transactional `Video.commentCount` decrement, leaving the aggregate corrupted.
 */
export const deleteVideoComment = async (
  deps: Pick<VideosDependencies, 'clock' | 'prisma'>,
  { actorRole, commentId, publicId, userId }: DeleteVideoCommentInput,
): Promise<void> => {
  const candidate = await deps.prisma.comment.findFirst({
    where: {
      id: commentId,
      video: {
        publicId,
      },
    },
    select: {
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
    resolveVideoCommentDeletionOrigin({
      actorRole,
      authorId: candidate.authorId,
      ownerId: candidate.video.ownerId,
      userId,
    }) === null
  ) {
    throw new VideoCommentNotFoundError();
  }

  await runVideoCommentTransaction(deps, async (tx) => {
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
      throw new VideoCommentNotFoundError();
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
        WHERE c."id" = CAST(${commentId} AS UUID)
          AND c."video_id" = CAST(${video.id} AS UUID)
        FOR UPDATE
      `,
    );

    const deletionOrigin = comment
      ? resolveVideoCommentDeletionOrigin({
          actorRole,
          authorId: comment.authorId,
          ownerId: video.ownerId,
          userId,
        })
      : null;

    if (!comment || deletionOrigin === null) {
      throw new VideoCommentNotFoundError();
    }

    if (comment.deletedAt) {
      return;
    }

    const deleted = await tx.comment.updateMany({
      where: {
        id: comment.id,
        videoId: video.id,
        deletedAt: null,
      },
      data: {
        content: null,
        deletedAt: deps.clock.now(),
        deletionOrigin,
      },
    });

    if (deleted.count === 0) {
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
