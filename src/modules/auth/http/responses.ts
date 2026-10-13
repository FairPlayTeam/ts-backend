import type { Request, Response } from 'express';
import type {
  AuthSessionResult,
  ListUserSessionsResult,
  AuthUser,
  AuthUserProfile,
} from '../sessions/types.js';
import type {
  ExportUserCommentData,
  ExportUserCommentLikeData,
  ExportUserDataResult,
  ExportUserFollowData,
  ExportUserSessionData,
  ExportUserVideoData,
  ExportUserVideoRatingData,
  ExportUserVideoViewData,
} from '../account/types.js';
import type { UserMediaAssetResult } from '../media/types.js';
import {
  sendNoStoreJson,
  setNoStore,
  toIsoString,
  toNullableIsoString,
} from '../../../controllers/http.responses.js';

export { sendNoStoreJson, setNoStore };

type SessionResponseInput = {
  publicId: string;
  expiresAt: Date;
};

export const toSessionResponse = (session: SessionResponseInput) => ({
  id: session.publicId,
  expiresAt: toIsoString(session.expiresAt),
});

export const toAuthUserResponse = (user: AuthUser) => ({
  email: user.email,
  username: user.username,
  displayName: user.displayName,
  bio: user.bio,
  role: user.role,
});

export const toAuthUserProfileResponse = (user: AuthUserProfile) => ({
  email: user.email,
  username: user.username,
  displayName: user.displayName,
  bio: user.bio,
  role: user.role,
  avatarUrl: user.avatarUrl,
  bannerUrl: user.bannerUrl,
});

export const toAuthSessionResponse = (result: AuthSessionResult) => ({
  message: result.message,
  user: toAuthUserResponse(result.user),
  sessionKey: result.sessionKey,
  session: toSessionResponse(result.session),
});

export const toUserSessionsResponse = ({
  sessions,
  total,
  nextCursor,
}: ListUserSessionsResult) => ({
  sessions: sessions.map((session) => ({
    id: session.id,
    sessionKeySuffix: session.sessionKeySuffix,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    deviceInfo: session.deviceInfo,
    isCurrent: session.isCurrent,
    createdAt: toIsoString(session.createdAt),
    lastUsedAt: toIsoString(session.lastUsedAt),
    expiresAt: toIsoString(session.expiresAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        lastUsedAt: toIsoString(nextCursor.lastUsedAt),
        id: nextCursor.id,
      }
    : null,
});

type UserDataExportToken = NonNullable<ExportUserDataResult['emailVerificationToken']>;

const toUserDataExportTokenResponse = (token: UserDataExportToken | null) =>
  token
    ? {
        createdAt: toIsoString(token.createdAt),
        expiresAt: toIsoString(token.expiresAt),
      }
    : null;

const toUserDataExportBaseResponse = (result: ExportUserDataResult) => ({
  exportedAt: toIsoString(result.exportedAt),
  user: {
    email: result.user.email,
    username: result.user.username,
    displayName: result.user.displayName,
    bio: result.user.bio,
    role: result.user.role,
    isVerified: result.user.isVerified,
    isBanned: result.user.isBanned,
    bannedAt: toNullableIsoString(result.user.bannedAt),
    banReason: result.user.banReason,
    createdAt: toIsoString(result.user.createdAt),
    updatedAt: toIsoString(result.user.updatedAt),
    lastLogin: toNullableIsoString(result.user.lastLogin),
  },
  emailVerificationToken: toUserDataExportTokenResponse(result.emailVerificationToken),
  passwordResetToken: toUserDataExportTokenResponse(result.passwordResetToken),
});

const toUserDataExportCommentResponse = (comment: ExportUserCommentData) => ({
  id: comment.id,
  videoPublicId: comment.videoPublicId,
  content: comment.content,
  createdAt: toIsoString(comment.createdAt),
  deletedAt: toNullableIsoString(comment.deletedAt),
  rootId: comment.rootId,
  replyingToCommentId: comment.replyingToCommentId,
});

const toUserDataExportCommentLikeResponse = (like: ExportUserCommentLikeData) => ({
  commentId: like.commentId,
  createdAt: toIsoString(like.createdAt),
});

const toUserDataExportVideoRatingResponse = (rating: ExportUserVideoRatingData) => ({
  videoPublicId: rating.videoPublicId,
  value: rating.value,
  createdAt: toIsoString(rating.createdAt),
  updatedAt: toIsoString(rating.updatedAt),
});

const toUserDataExportVideoViewResponse = (view: ExportUserVideoViewData) => ({
  videoPublicId: view.videoPublicId,
  viewedOn: toIsoString(view.viewedOn).slice(0, 10),
});

const toUserDataExportSessionResponse = (session: ExportUserSessionData) => ({
  id: session.id,
  sessionKeySuffix: session.sessionKeySuffix,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  deviceInfo: session.deviceInfo,
  isActive: session.isActive,
  isCurrent: session.isCurrent,
  createdAt: toIsoString(session.createdAt),
  updatedAt: toIsoString(session.updatedAt),
  lastUsedAt: toIsoString(session.lastUsedAt),
  expiresAt: toIsoString(session.expiresAt),
});

const toUserDataExportFollowResponse = (follow: ExportUserFollowData) => ({
  username: follow.username,
  displayName: follow.displayName,
  createdAt: toIsoString(follow.createdAt),
});

const toUserDataExportVideoResponse = (video: ExportUserVideoData) => ({
  publicId: video.publicId,
  title: video.title,
  description: video.description,
  tags: video.tags.map((tag) => tag),
  license: video.license,
  visibility: video.visibility,
  allowComments: video.allowComments,
  processingStatus: video.processingStatus,
  moderationStatus: video.moderationStatus,
  durationSeconds: video.durationSeconds,
  width: video.width,
  height: video.height,
  viewCount: video.viewCount,
  ratingCount: video.ratingCount,
  commentCount: video.commentCount,
  publishedAt: toNullableIsoString(video.publishedAt),
  rejectedAt: toNullableIsoString(video.rejectedAt),
  rejectionReason: video.rejectionReason,
  deletionRequestedAt: toNullableIsoString(video.deletionRequestedAt),
  deletionReason: video.deletionReason,
  deletionOrigin: video.deletionOrigin,
  createdAt: toIsoString(video.createdAt),
  updatedAt: toIsoString(video.updatedAt),
});

const writeResponseChunk = async (res: Response, chunk: string): Promise<boolean> => {
  if (res.destroyed || res.writableEnded) {
    return false;
  }

  if (res.write(chunk)) {
    return true;
  }

  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      res.off('close', onClose);
      res.off('drain', onDrain);
      res.off('error', onError);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    res.once('close', onClose);
    res.once('drain', onDrain);
    res.once('error', onError);

    if (res.destroyed || res.writableEnded) {
      cleanup();
      resolve(false);
    }
  });
};

export const streamUserDataExportResponse = async (
  res: Response,
  result: ExportUserDataResult,
): Promise<void> => {
  const baseJson = JSON.stringify(toUserDataExportBaseResponse(result));

  res.status(200).type('application/json');

  if (!(await writeResponseChunk(res, baseJson.slice(0, -1)))) {
    return;
  }

  const writeArray = async <T>(
    property: string,
    values: AsyncIterable<T>,
    serialize: (value: T) => unknown,
  ): Promise<boolean> => {
    if (!(await writeResponseChunk(res, `,"${property}":[`))) {
      return false;
    }

    let isFirst = true;

    for await (const value of values) {
      const separator = isFirst ? '' : ',';
      const chunk = `${separator}${JSON.stringify(serialize(value))}`;

      if (!(await writeResponseChunk(res, chunk))) {
        return false;
      }

      isFirst = false;
    }

    return writeResponseChunk(res, ']');
  };

  if (
    !(await writeArray('following', result.following, toUserDataExportFollowResponse)) ||
    !(await writeArray('followers', result.followers, toUserDataExportFollowResponse)) ||
    !(await writeArray('videos', result.videos, toUserDataExportVideoResponse)) ||
    !(await writeArray('videoRatings', result.videoRatings, toUserDataExportVideoRatingResponse)) ||
    !(await writeArray('videoViews', result.videoViews, toUserDataExportVideoViewResponse)) ||
    !(await writeArray('comments', result.comments, toUserDataExportCommentResponse)) ||
    !(await writeArray('commentLikes', result.commentLikes, toUserDataExportCommentLikeResponse)) ||
    !(await writeArray('sessions', result.sessions, toUserDataExportSessionResponse))
  ) {
    return;
  }

  res.end('}\n');
};

export const toUserMediaAssetResponse = (asset: UserMediaAssetResult) => ({
  url: asset.url,
  mimeType: asset.mimeType,
  sizeBytes: asset.sizeBytes,
  width: asset.width,
  height: asset.height,
  updatedAt: toIsoString(asset.updatedAt),
});

export const toUserMediaFileInput = (file: Request['file']) =>
  file
    ? {
        buffer: file.buffer,
        size: file.size,
      }
    : {
        buffer: Buffer.alloc(0),
        size: 0,
      };
