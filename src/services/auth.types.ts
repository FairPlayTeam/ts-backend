export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: string;
};

type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

type LoginInput = {
  emailOrUsername: string;
  password: string;
};

type VerifyEmailInput = {
  token: string;
};

type ResendVerificationInput = {
  email: string;
};

type UpdateProfileInput = {
  displayName?: string | null | undefined;
  bio?: string | null | undefined;
};

export type AuthSessionResult = {
  message: string;
  user: AuthUser;
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

export type CleanupSessionsResult = {
  message: string;
  sessionsDeleted: number;
};

type ValidatedAuthSession = {
  user: AuthUser;
  session: AuthSessionResult['session'];
};

export type AuthService = {
  register(input: RegisterInput): Promise<{ message: string }>;
  login(
    input: LoginInput & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  verifyEmail(
    input: VerifyEmailInput & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  validateSession(sessionKey: string): Promise<ValidatedAuthSession | null>;
  resendVerification(input: ResendVerificationInput): Promise<{ message: string }>;
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
  updateProfile(
    input: UpdateProfileInput & {
      userId: string;
    },
  ): Promise<{ message: string; user: AuthUser }>;
  cleanupSessions(input: {
    expiredBefore: Date;
    inactiveUpdatedBefore: Date;
  }): Promise<CleanupSessionsResult>;
};
