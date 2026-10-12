import type { AuthSessionResult } from '../sessions/types.js';

export type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

export type LoginInput = {
  emailOrUsername: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type AuthCredentialsPort = {
  register: (input: RegisterInput) => Promise<{ message: string }>;
  login: (input: LoginInput) => Promise<AuthSessionResult>;
};

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

export type RequestPasswordResetInput = {
  email: string;
};

export type ResetPasswordInput = {
  email: string;
  code: string;
  password: string;
};

export type AuthPasswordResetPort = {
  requestPasswordReset: (input: RequestPasswordResetInput) => Promise<{ message: string }>;
  resetPassword: (
    input: ResetPasswordInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
};
