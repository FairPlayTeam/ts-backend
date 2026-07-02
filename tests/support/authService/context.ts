import type { createAuthService } from '../../../src/services/auth.service.js';

export type AuthDeps = Parameters<typeof createAuthService>[0];

export const fixedNow = new Date('2026-01-01T00:00:00.000Z');
export const avatarObjectKeyPattern =
  /^users\/user-id\/avatar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export const bannerObjectKeyPattern =
  /^users\/user-id\/banner\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

export type AuthServiceTestCalls = {
  userFindUnique: unknown;
  userFindFirst: unknown;
  userCreate: unknown;
  userDeleteMany: unknown;
  userUpdate: unknown;
  userUpdateMany: unknown;
  userMediaAssetDeleteMany: unknown;
  userMediaAssetFindMany: unknown;
  userMediaAssetFindUnique: unknown;
  userMediaAssetUpsert: unknown;
  userMediaDeletionJobCreateMany: unknown;
  userMediaDeletionJobDeleteMany: unknown;
  userMediaDeletionJobFindMany: unknown;
  userMediaDeletionJobUpdateMany: unknown;
  tokenCreate: unknown;
  tokenDeleteMany: unknown;
  tokenFindUnique: unknown;
  tokenUpsert: unknown;
  passwordResetTokenDeleteMany: unknown;
  passwordResetTokenFindUnique: unknown;
  passwordResetTokenUpsert: unknown;
  passwordResetUserFindUnique: unknown;
  passwordResetCurrentUserFindUnique: unknown;
  sessionCreate: unknown;
  sessionCount: unknown;
  sessionFindMany: unknown;
  sessionFindUnique: unknown;
  sessionUpdate: unknown;
  sessionUpdateMany: unknown;
  sessionDeleteMany: unknown;
  putObject: unknown;
  deleteObject: unknown;
  deleteObjects: unknown;
  signedUrlObjectKey: unknown;
  signedUrlObjectKeys: string[];
  processedMedia: unknown;
  comparedPassword: unknown;
  sentEmail: unknown;
  warning: unknown;
};

export const createAuthServiceTestCalls = (): AuthServiceTestCalls => ({
  userFindUnique: undefined,
  userFindFirst: undefined,
  userCreate: undefined,
  userDeleteMany: undefined,
  userUpdate: undefined,
  userUpdateMany: undefined,
  userMediaAssetDeleteMany: undefined,
  userMediaAssetFindMany: undefined,
  userMediaAssetFindUnique: undefined,
  userMediaAssetUpsert: undefined,
  userMediaDeletionJobCreateMany: undefined,
  userMediaDeletionJobDeleteMany: undefined,
  userMediaDeletionJobFindMany: undefined,
  userMediaDeletionJobUpdateMany: undefined,
  tokenCreate: undefined,
  tokenDeleteMany: undefined,
  tokenFindUnique: undefined,
  tokenUpsert: undefined,
  passwordResetTokenDeleteMany: undefined,
  passwordResetTokenFindUnique: undefined,
  passwordResetTokenUpsert: undefined,
  passwordResetUserFindUnique: undefined,
  passwordResetCurrentUserFindUnique: undefined,
  sessionCreate: undefined,
  sessionCount: undefined,
  sessionFindMany: undefined,
  sessionFindUnique: undefined,
  sessionUpdate: undefined,
  sessionUpdateMany: undefined,
  sessionDeleteMany: undefined,
  putObject: undefined,
  deleteObject: undefined,
  deleteObjects: undefined,
  signedUrlObjectKey: undefined,
  signedUrlObjectKeys: [],
  processedMedia: undefined,
  comparedPassword: undefined,
  sentEmail: undefined,
  warning: undefined,
});
