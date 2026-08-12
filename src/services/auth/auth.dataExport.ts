import type { AuthDependencies } from './auth.dependencies.js';
import { reauthenticateSensitiveAction } from './auth.reauthentication.js';
import type {
  AuthAccountPort,
  ExportUserCommentData,
  ExportUserCommentLikeData,
  ExportUserSessionData,
  ExportUserVideoRatingData,
  ExportUserVideoViewData,
  ExportUserDataInput,
} from './types/account.types.js';
import { AuthenticatedUserNotFoundError } from '../auth.errors.js';
import { profileAvatarPath, profileBannerPath } from '../assets/assetLinks.js';

type DataExportService = Pick<AuthAccountPort, 'exportUserData'>;

const USER_DATA_EXPORT_BATCH_SIZE = 250;

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
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        mediaAssets: {
          select: {
            id: true,
            kind: true,
            mimeType: true,
            sizeBytes: true,
            width: true,
            height: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        },
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

    const { emailVerificationTokens, mediaAssets, passwordResetToken, ...exportedUser } = user;
    return {
      exportedAt,
      user: exportedUser,
      mediaAssets: mediaAssets.map(
        ({ id, kind, mimeType, sizeBytes, width, height, createdAt, updatedAt }) => ({
          id,
          kind,
          url:
            kind === 'avatar'
              ? profileAvatarPath(exportedUser.username)
              : profileBannerPath(exportedUser.username),
          mimeType,
          sizeBytes,
          width,
          height,
          createdAt,
          updatedAt,
        }),
      ),
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
