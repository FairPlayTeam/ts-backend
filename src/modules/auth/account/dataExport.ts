import type { Prisma } from '@prisma/client';
import type { AuthDependencies } from '../dependencies.js';
import {
  lockAuthenticatedUser,
  reauthenticateSensitiveAction,
} from '../credentials/reauthentication.js';
import type {
  AuthAccountPort,
  ExportUserCommentData,
  ExportUserCommentLikeData,
  ExportUserFollowData,
  ExportUserSessionData,
  ExportUserVideoData,
  ExportUserVideoRatingData,
  ExportUserVideoViewData,
  ExportUserDataInput,
} from './types.js';
import { InvalidCredentialsError } from '../errors.js';

type DataExportService = Pick<AuthAccountPort, 'exportUserData'>;

const USER_DATA_EXPORT_BATCH_SIZE = 250;
type ExportPageReader = <T>(load: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
type FollowingExportRow = {
  followingId: string;
  createdAt: Date;
  following: Pick<ExportUserFollowData, 'username' | 'displayName'>;
};
type FollowerExportRow = {
  followerId: string;
  createdAt: Date;
  follower: Pick<ExportUserFollowData, 'username' | 'displayName'>;
};
type OwnedVideoExportRow = ExportUserVideoData & { id: string };
type CommentExportRow = {
  id: string;
  publicId: string;
  createdAt: Date;
  video: { publicId: string };
  content: string | null;
  deletedAt: Date | null;
  root: { publicId: string } | null;
  replyingToComment: { publicId: string } | null;
};
type CommentLikeExportRow = {
  commentId: string;
  createdAt: Date;
  comment: { publicId: string };
};
type VideoRatingExportRow = {
  videoId: string;
  video: { publicId: string };
  value: number;
  createdAt: Date;
  updatedAt: Date;
};
type VideoViewExportRow = {
  videoId: string;
  video: { publicId: string };
  viewedOn: Date;
};
type SessionExportRow = Omit<ExportUserSessionData, 'id'> & {
  id: string;
  publicId: string;
};

const createPaginatedExport = <TRow>(
  readPage: ExportPageReader,
  loadPage: (tx: Prisma.TransactionClient, cursor: TRow | undefined) => Promise<TRow[]>,
): AsyncIterable<TRow> => ({
  async *[Symbol.asyncIterator]() {
    let cursor: TRow | undefined;

    while (true) {
      const rows = await readPage((tx) => loadPage(tx, cursor));

      yield* rows;

      if (rows.length < USER_DATA_EXPORT_BATCH_SIZE) {
        return;
      }

      cursor = rows.at(-1);

      if (!cursor) {
        return;
      }
    }
  },
});

const projectExport = <TRow, TExport>(
  rows: AsyncIterable<TRow>,
  project: (row: TRow) => TExport,
): AsyncIterable<TExport> => ({
  async *[Symbol.asyncIterator]() {
    for await (const row of rows) {
      yield project(row);
    }
  },
});

const createCommentExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserCommentData> =>
  projectExport<CommentExportRow, ExportUserCommentData>(
    createPaginatedExport<CommentExportRow>(readPage, (tx, cursor) =>
      tx.comment
        .findMany({
          where: {
            authorId: userId,
            ...(cursor
              ? {
                  createdAt: { gte: cursor.createdAt },
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            publicId: true,
            video: { select: { publicId: true } },
            content: true,
            createdAt: true,
            deletedAt: true,
            root: { select: { publicId: true } },
            replyingToComment: { select: { publicId: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: USER_DATA_EXPORT_BATCH_SIZE,
        })
        .then((comments) => {
          for (const comment of comments) {
            const isActive = comment.deletedAt === null;

            if ((isActive && comment.content === null) || (!isActive && comment.content !== null)) {
              throw new Error('Exported comment violated its lifecycle invariant');
            }
          }

          return comments;
        }),
    ),
    ({ publicId, video, content, createdAt, deletedAt, root, replyingToComment }) => ({
      id: publicId,
      videoPublicId: video.publicId,
      content,
      createdAt,
      deletedAt,
      rootId: root?.publicId ?? null,
      replyingToCommentId: replyingToComment?.publicId ?? null,
    }),
  );

const createCommentLikeExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserCommentLikeData> =>
  projectExport<CommentLikeExportRow, ExportUserCommentLikeData>(
    createPaginatedExport<CommentLikeExportRow>(readPage, (tx, cursor) =>
      tx.commentLike.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                commentId: { gt: cursor.commentId },
              }
            : {}),
        },
        select: {
          commentId: true,
          comment: { select: { publicId: true } },
          createdAt: true,
        },
        orderBy: [{ commentId: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ comment, createdAt }) => ({ commentId: comment.publicId, createdAt }),
  );

const createVideoRatingExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserVideoRatingData> =>
  projectExport(
    createPaginatedExport<VideoRatingExportRow>(readPage, (tx, cursor) =>
      tx.videoRating.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                createdAt: { gte: cursor.createdAt },
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, videoId: { gt: cursor.videoId } },
                ],
              }
            : {}),
        },
        select: {
          videoId: true,
          video: { select: { publicId: true } },
          value: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { videoId: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ video, value, createdAt, updatedAt }) => ({
      videoPublicId: video.publicId,
      value,
      createdAt,
      updatedAt,
    }),
  );

const createVideoViewExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserVideoViewData> =>
  projectExport(
    createPaginatedExport<VideoViewExportRow>(readPage, (tx, cursor) =>
      tx.videoView.findMany({
        where: {
          userId,
          ...(cursor
            ? {
                viewedOn: { gte: cursor.viewedOn },
                OR: [
                  { viewedOn: { gt: cursor.viewedOn } },
                  { viewedOn: cursor.viewedOn, videoId: { gt: cursor.videoId } },
                ],
              }
            : {}),
        },
        select: {
          videoId: true,
          video: { select: { publicId: true } },
          viewedOn: true,
        },
        orderBy: [{ viewedOn: 'asc' }, { videoId: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ video, viewedOn }) => ({
      videoPublicId: video.publicId,
      viewedOn,
    }),
  );

const createSessionExport = (
  readPage: ExportPageReader,
  userId: string,
  currentSessionId: string,
): AsyncIterable<ExportUserSessionData> =>
  projectExport<SessionExportRow, ExportUserSessionData>(
    createPaginatedExport<SessionExportRow>(readPage, (tx, cursor) =>
      tx.session
        .findMany({
          where: {
            userId,
            ...(cursor
              ? {
                  createdAt: { gte: cursor.createdAt },
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            publicId: true,
            sessionKeySuffix: true,
            ipAddress: true,
            userAgent: true,
            deviceInfo: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: USER_DATA_EXPORT_BATCH_SIZE,
        })
        .then((sessions) =>
          sessions.map((session) => ({
            ...session,
            isCurrent: session.id === currentSessionId,
          })),
        ),
    ),
    ({ id: _internalId, publicId, ...session }) => ({
      ...session,
      id: publicId,
    }),
  );

const createFollowingExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserFollowData> =>
  projectExport<FollowingExportRow, ExportUserFollowData>(
    createPaginatedExport<FollowingExportRow>(readPage, (tx, cursor) =>
      tx.userFollow.findMany({
        where: {
          followerId: userId,
          ...(cursor
            ? {
                createdAt: { gte: cursor.createdAt },
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, followingId: { gt: cursor.followingId } },
                ],
              }
            : {}),
        },
        select: {
          followingId: true,
          createdAt: true,
          following: { select: { username: true, displayName: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { followingId: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ following, createdAt }) => ({ ...following, createdAt }),
  );

const createFollowerExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserFollowData> =>
  projectExport<FollowerExportRow, ExportUserFollowData>(
    createPaginatedExport<FollowerExportRow>(readPage, (tx, cursor) =>
      tx.userFollow.findMany({
        where: {
          followingId: userId,
          ...(cursor
            ? {
                createdAt: { gte: cursor.createdAt },
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, followerId: { gt: cursor.followerId } },
                ],
              }
            : {}),
        },
        select: {
          followerId: true,
          createdAt: true,
          follower: { select: { username: true, displayName: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { followerId: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ follower, createdAt }) => ({ ...follower, createdAt }),
  );

const createOwnedVideoExport = (
  readPage: ExportPageReader,
  userId: string,
): AsyncIterable<ExportUserVideoData> =>
  projectExport<OwnedVideoExportRow, ExportUserVideoData>(
    createPaginatedExport<OwnedVideoExportRow>(readPage, (tx, cursor) =>
      tx.video.findMany({
        where: {
          ownerId: userId,
          ...(cursor
            ? {
                createdAt: { gte: cursor.createdAt },
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          publicId: true,
          title: true,
          description: true,
          tags: true,
          license: true,
          visibility: true,
          allowComments: true,
          processingStatus: true,
          moderationStatus: true,
          durationSeconds: true,
          width: true,
          height: true,
          viewCount: true,
          ratingCount: true,
          commentCount: true,
          publishedAt: true,
          rejectedAt: true,
          rejectionReason: true,
          deletionRequestedAt: true,
          deletionReason: true,
          deletionOrigin: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: USER_DATA_EXPORT_BATCH_SIZE,
      }),
    ),
    ({ id: _id, ...video }) => video,
  );

export const createDataExportService = (deps: AuthDependencies): DataExportService => ({
  async exportUserData({ userId, currentSessionId, currentPassword }: ExportUserDataInput) {
    const authenticatedPasswordHash = await reauthenticateSensitiveAction(deps, {
      userId,
      currentPassword,
    });
    const readPage: ExportPageReader = (load) =>
      deps.prisma.$transaction(async (tx) => {
        await lockAuthenticatedUser(tx, userId, authenticatedPasswordHash);
        return load(tx);
      });

    const exportedAt = deps.clock.now();

    const user = await readPage((tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          username: true,
          displayName: true,
          bio: true,
          role: true,
          isVerified: true,
          isBanned: true,
          bannedAt: true,
          banReason: true,
          createdAt: true,
          updatedAt: true,
          lastLogin: true,
          emailVerificationTokens: {
            select: {
              id: true,
              createdAt: true,
              expiresAt: true,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
          passwordResetToken: {
            select: {
              createdAt: true,
              expiresAt: true,
            },
          },
        },
      }),
    );

    if (!user) {
      throw new InvalidCredentialsError();
    }

    const emailVerificationToken = user.emailVerificationTokens[0];
    return {
      exportedAt,
      user: {
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        role: user.role,
        isVerified: user.isVerified,
        isBanned: user.isBanned,
        bannedAt: user.bannedAt,
        banReason: user.banReason,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLogin: user.lastLogin,
      },
      following: createFollowingExport(readPage, userId),
      followers: createFollowerExport(readPage, userId),
      videos: createOwnedVideoExport(readPage, userId),
      videoRatings: createVideoRatingExport(readPage, userId),
      videoViews: createVideoViewExport(readPage, userId),
      comments: createCommentExport(readPage, userId),
      commentLikes: createCommentLikeExport(readPage, userId),
      sessions: createSessionExport(readPage, userId, currentSessionId),
      emailVerificationToken: emailVerificationToken
        ? {
            createdAt: emailVerificationToken.createdAt,
            expiresAt: emailVerificationToken.expiresAt,
          }
        : null,
      passwordResetToken: user.passwordResetToken
        ? {
            createdAt: user.passwordResetToken.createdAt,
            expiresAt: user.passwordResetToken.expiresAt,
          }
        : null,
    };
  },
});
