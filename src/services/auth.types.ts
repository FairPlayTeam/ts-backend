import type {
  LoginRequestBody,
  RegisterRequestBody,
  ResendVerificationRequestBody,
  VerifyEmailRequestBody,
} from '../controllers/auth.schemas.js';

export type AuthSessionResult = {
  message: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
  sessionKey: string;
  session: {
    id: string;
    expiresAt: Date;
  };
};

export type UserSessionSummary = {
  id: string;
  sessionKeySuffix: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: string | null;
  isCurrent: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

type ValidatedAuthSession = {
  user: AuthSessionResult['user'];
  session: AuthSessionResult['session'];
};

export type AuthService = {
  register(input: RegisterRequestBody): Promise<{ message: string }>;
  login(
    input: LoginRequestBody & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  verifyEmail(
    input: VerifyEmailRequestBody & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  validateSession(sessionKey: string): Promise<ValidatedAuthSession | null>;
  resendVerification(input: ResendVerificationRequestBody): Promise<{ message: string }>;
  getUserSessions(input: {
    userId: string;
    currentSessionId: string;
  }): Promise<{ sessions: UserSessionSummary[]; total: number }>;
  logoutAllSessions(input: {
    userId: string;
  }): Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutOtherSessions(input: {
    userId: string;
    currentSessionId: string;
  }): Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutSession(input: {
    userId: string;
    sessionId: string;
  }): Promise<{ message: string; sessionsLoggedOut: number }>;
};
