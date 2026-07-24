import type { CleanupSessionsInput, CleanupSessionsResult } from './sessions.types.js';

export type CleanupExpiredAuthTokensInput = {
  expiredBefore: Date;
};

export type CleanupExpiredAuthTokensResult = {
  message: string;
  emailVerificationTokensDeleted: number;
  passwordResetTokensDeleted: number;
};

export type ReconcileUserMediaTargetsInput = {
  limit?: number;
};

export type ReconcileUserMediaTargetsResult = {
  message: string;
  mediaTargetsConfirmed: number;
  mediaTargetsFailed: number;
};

export type AuthMaintenancePort = {
  cleanupSessions: (input: CleanupSessionsInput) => Promise<CleanupSessionsResult>;
  cleanupExpiredAuthTokens: (
    input: CleanupExpiredAuthTokensInput,
  ) => Promise<CleanupExpiredAuthTokensResult>;
  reconcileUserMediaTargets: (
    input: ReconcileUserMediaTargetsInput,
  ) => Promise<ReconcileUserMediaTargetsResult>;
};
