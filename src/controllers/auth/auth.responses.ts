import type { Request, Response } from 'express';
import type {
  AuthSessionResult,
  ExportUserCommentData,
  ExportUserCommentLikeData,
  ExportUserDataResult,
  ExportUserSessionData,
  ExportUserVideoRatingData,
  ExportUserVideoViewData,
  ListUserSessionsResult,
  UserMediaAssetResult,
} from '../../services/auth.types.js';
import {
  sendNoStoreJson,
  setNoStore,
  toIsoString,
  toNullableIsoString,
} from '../http.responses.js';

export { sendNoStoreJson, setNoStore };

type SessionResponseInput = {
  id: string;
  expiresAt: Date;
};

export const toSessionResponse = (session: SessionResponseInput) => ({
  id: session.id,
  expiresAt: toIsoString(session.expiresAt),
});

export const toAuthSessionResponse = (result: AuthSessionResult) => ({
  message: result.message,
  user: result.user,
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
        ...token,
        createdAt: toIsoString(token.createdAt),
        expiresAt: toIsoString(token.expiresAt),
      }
    : null;

const toUserDataExportBaseResponse = ({
  commentLikes: _commentLikes,
  comments: _comments,
  sessions: _sessions,
  videoRatings: _videoRatings,
  videoViews: _videoViews,
  ...result
}: ExportUserDataResult) => ({
  exportedAt: toIsoString(result.exportedAt),
  user: {
    ...result.user,
    bannedAt: toNullableIsoString(result.user.bannedAt),
    createdAt: toIsoString(result.user.createdAt),
    updatedAt: toIsoString(result.user.updatedAt),
    lastLogin: toNullableIsoString(result.user.lastLogin),
  },
  mediaAssets: result.mediaAssets.map((asset) => ({
    ...asset,
    createdAt: toIsoString(asset.createdAt),
    updatedAt: toIsoString(asset.updatedAt),
  })),
  emailVerificationToken: toUserDataExportTokenResponse(result.emailVerificationToken),
  passwordResetToken: toUserDataExportTokenResponse(result.passwordResetToken),
});

const toUserDataExportCommentResponse = (comment: ExportUserCommentData) => ({
  ...comment,
  createdAt: toIsoString(comment.createdAt),
  deletedAt: toNullableIsoString(comment.deletedAt),
});

const toUserDataExportCommentLikeResponse = (like: ExportUserCommentLikeData) => ({
  ...like,
  createdAt: toIsoString(like.createdAt),
});

const toUserDataExportVideoRatingResponse = (rating: ExportUserVideoRatingData) => ({
  ...rating,
  createdAt: toIsoString(rating.createdAt),
  updatedAt: toIsoString(rating.updatedAt),
});

const toUserDataExportVideoViewResponse = (view: ExportUserVideoViewData) => ({
  ...view,
  viewedOn: toIsoString(view.viewedOn).slice(0, 10),
});

const toUserDataExportSessionResponse = (session: ExportUserSessionData) => ({
  ...session,
  createdAt: toIsoString(session.createdAt),
  updatedAt: toIsoString(session.updatedAt),
  lastUsedAt: toIsoString(session.lastUsedAt),
  expiresAt: toIsoString(session.expiresAt),
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
  ...asset,
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
