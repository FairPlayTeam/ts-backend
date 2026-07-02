import type { AuthSessionResult } from './sessions.types.js';

export type VerifyEmailInput = {
  email: string;
  code: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type ResendVerificationInput = {
  email: string;
};

export type AuthEmailVerificationPort = {
  verifyEmail: (input: VerifyEmailInput) => Promise<AuthSessionResult>;
  resendVerification: (input: ResendVerificationInput) => Promise<{ message: string }>;
};
