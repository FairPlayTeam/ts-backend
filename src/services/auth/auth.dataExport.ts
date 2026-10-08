import type { AuthDependencies } from './auth.dependencies.js';
import { reauthenticateSensitiveAction } from './auth.reauthentication.js';
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
} from './types/account.types.js';
import { AuthenticatedUserNotFoundError } from '../auth.errors.js';

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
  createPaginatedExport((cursor) =>
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
          videoId: true,
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
  createPaginatedExport((cursor) =>
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
        value: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { videoId: 'asc' }],
      take: USER_DATA_EXPORT_BATCH_SIZE,
    }),
  );

const createVideoViewExport = (
  deps: AuthDependencies,
  userId: string,
): AsyncIterable<ExportUserVideoViewData> =>
  createPaginatedExport((cursor) =>
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
        viewedOn: true,
      },
      orderBy: [{ viewedOn: 'asc' }, { videoId: 'asc' }],
      take: USER_DATA_EXPORT_BATCH_SIZE,
    }),
  );

const createSessionExport = (
  deps: AuthDependencies,
  userId: string,
  currentSessionId: string,
): AsyncIterable<ExportUserSessionData> =>
  createPaginatedExport(async (cursor) => {
    const sessions = await deps.prisma.session.findMany({
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
    });

    return sessions.map((session) => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));
  });

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
        id: true,
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
            id: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new AuthenticatedUserNotFoundError();
    }

    const { emailVerificationTokens, passwordResetToken, ...exportedUser } = user;
    return {
      exportedAt,
      user: exportedUser,
      following: createFollowingExport(deps, userId),
      followers: createFollowerExport(deps, userId),
      videos: createOwnedVideoExport(deps, userId),
      videoRatings: createVideoRatingExport(deps, userId),
      videoViews: createVideoViewExport(deps, userId),
      comments: createCommentExport(deps, userId),
      commentLikes: createCommentLikeExport(deps, userId),
      sessions: createSessionExport(deps, userId, currentSessionId),
      emailVerificationToken: emailVerificationTokens[0] ?? null,
      passwordResetToken,
    };
  },
});
