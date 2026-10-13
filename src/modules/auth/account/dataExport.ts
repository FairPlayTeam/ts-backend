import type { AuthDependencies } from '../dependencies.js';
import { reauthenticateSensitiveAction } from '../credentials/reauthentication.js';
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
import { AuthenticatedUserNotFoundError } from '../errors.js';

type DataExportService = Pick<AuthAccountPort, 'exportUserData'>;

const USER_DATA_EXPORT_BATCH_SIZE = 250;
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
type CommentExportRow = Omit<ExportUserCommentData, 'videoPublicId'> & {
  video: { publicId: string };
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
  loadPage: (cursor: TRow | undefined) => Promise<TRow[]>,
): AsyncIterable<TRow> => ({
  async *[Symbol.asyncIterator]() {
    let cursor: TRow | undefined;

    while (true) {
      const rows = await loadPage(cursor);

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
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserCommentData> =>
  projectExport<CommentExportRow, ExportUserCommentData>(
    createPaginatedExport<CommentExportRow>((cursor) =>
      deps.prisma.comment
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
            video: { select: { publicId: true } },
            content: true,
            createdAt: true,
            deletedAt: true,
            rootId: true,
            replyingToCommentId: true,
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
    ({ id, video, content, createdAt, deletedAt, rootId, replyingToCommentId }) => ({
      id,
      videoPublicId: video.publicId,
      content,
      createdAt,
      deletedAt,
      rootId,
      replyingToCommentId,
    }),
  );

const createCommentLikeExport = (
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserCommentLikeData> =>
  createPaginatedExport((cursor) =>
    deps.prisma.commentLike.findMany({
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
        createdAt: true,
      },
      orderBy: [{ commentId: 'asc' }],
      take: USER_DATA_EXPORT_BATCH_SIZE,
    }),
  );

const createVideoRatingExport = (
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserVideoRatingData> =>
  projectExport(
    createPaginatedExport<VideoRatingExportRow>((cursor) =>
      deps.prisma.videoRating.findMany({
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
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserVideoViewData> =>
  projectExport(
    createPaginatedExport<VideoViewExportRow>((cursor) =>
      deps.prisma.videoView.findMany({
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
  deps: AuthDependencies,
  userId: string,
  currentSessionId: string,
): AsyncIterable<ExportUserSessionData> =>
  projectExport<SessionExportRow, ExportUserSessionData>(
    createPaginatedExport<SessionExportRow>((cursor) =>
      deps.prisma.session
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
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserFollowData> =>
  projectExport<FollowingExportRow, ExportUserFollowData>(
    createPaginatedExport<FollowingExportRow>((cursor) =>
      deps.prisma.userFollow.findMany({
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
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserFollowData> =>
  projectExport<FollowerExportRow, ExportUserFollowData>(
    createPaginatedExport<FollowerExportRow>((cursor) =>
      deps.prisma.userFollow.findMany({
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
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserVideoData> =>
  projectExport<OwnedVideoExportRow, ExportUserVideoData>(
    createPaginatedExport<OwnedVideoExportRow>((cursor) =>
      deps.prisma.video.findMany({
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
    await reauthenticateSensitiveAction(deps, { userId, currentPassword });

    const exportedAt = deps.clock.now();

    const user = await deps.prisma.user.findUnique({
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
    });

    if (!user) {
      throw new AuthenticatedUserNotFoundError();
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
      following: createFollowingExport(deps, userId),
      followers: createFollowerExport(deps, userId),
      videos: createOwnedVideoExport(deps, userId),
      videoRatings: createVideoRatingExport(deps, userId),
      videoViews: createVideoViewExport(deps, userId),
      comments: createCommentExport(deps, userId),
      commentLikes: createCommentLikeExport(deps, userId),
      sessions: createSessionExport(deps, userId, currentSessionId),
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
