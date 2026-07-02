import type { CleanupSessionsInput, CleanupSessionsResult } from './sessions.types.js';

export type CleanupExpiredAuthTokensInput = {
  expiredBefore: Date;
};

export type CleanupExpiredAuthTokensResult = {
  message: string;
  emailVerificationTokensDeleted: number;
  passwordResetTokensDeleted: number;
};

export type CleanupPendingUserMediaDeletionsInput = {
  pendingBefore: Date;
  limit?: number;
};

export type CleanupPendingUserMediaDeletionsResult = {
  message: string;
  mediaObjectsDeleted: number;
  mediaObjectDeletionJobsFailed: number;
};

export type AuthMaintenancePort = {
  cleanupSessions: (input: CleanupSessionsInput) => Promise<CleanupSessionsResult>;
  cleanupExpiredAuthTokens: (
    input: CleanupExpiredAuthTokensInput,
  ) => Promise<CleanupExpiredAuthTokensResult>;
  cleanupPendingUserMediaDeletions: (
    input: CleanupPendingUserMediaDeletionsInput,
  ) => Promise<CleanupPendingUserMediaDeletionsResult>;
};
