import type { Request } from 'express';
import type {
  AuthSessionResult,
  ExportUserDataResult,
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

export const toUserDataExportResponse = (result: ExportUserDataResult) => ({
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
  sessions: result.sessions.map((session) => ({
    ...session,
    createdAt: toIsoString(session.createdAt),
    updatedAt: toIsoString(session.updatedAt),
    lastUsedAt: toIsoString(session.lastUsedAt),
    expiresAt: toIsoString(session.expiresAt),
  })),
  emailVerificationToken: toUserDataExportTokenResponse(result.emailVerificationToken),
  passwordResetToken: toUserDataExportTokenResponse(result.passwordResetToken),
});

export const toPrettyJson = (body: unknown): string => JSON.stringify(body, null, 2) + '\n';

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
