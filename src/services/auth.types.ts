export type Session = {
  id: string;
  expiresAt: Date;
};

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: string;
};

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

export type VerifyEmailInput = {
  token: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type ResendVerificationInput = {
  email: string;
};

export type UpdateProfileInput = {
  userId: string;
  displayName?: string | null | undefined;
  bio?: string | null | undefined;
};

export type AuthSessionResult = {
  message: string;
  user: AuthUser;
  sessionKey: string;
  session: Session;
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

export type ValidatedAuthSession = {
  user: AuthUser;
  session: AuthSessionResult['session'];
};

export type ListUserSessionsInput = {
  userId: string;
  currentSessionId: string;
};

export type LogoutAllSessionsInput = {
  userId: string;
};

export type LogoutOtherSessionsInput = {
  userId: string;
  currentSessionId: string;
};

export type LogoutSessionInput = {
  userId: string;
  sessionId: string;
};

export type CleanupSessionsInput = {
  expiredBefore: Date;
  inactiveUpdatedBefore: Date;
};

export type AuthService = {
  register(input: RegisterInput): Promise<{ message: string }>;
  login(input: LoginInput): Promise<AuthSessionResult>;
  verifyEmail(input: VerifyEmailInput): Promise<AuthSessionResult>;
  validateSession(sessionKey: string): Promise<ValidatedAuthSession | null>;
  resendVerification(input: ResendVerificationInput): Promise<{ message: string }>;
  getUserSessions(
    input: ListUserSessionsInput,
  ): Promise<{ sessions: UserSessionSummary[]; total: number }>;
  logoutAllSessions(
    input: LogoutAllSessionsInput,
  ): Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutOtherSessions(
    input: LogoutOtherSessionsInput,
  ): Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutSession(input: LogoutSessionInput): Promise<{ message: string; sessionsLoggedOut: number }>;
  updateProfile(input: UpdateProfileInput): Promise<{ message: string; user: AuthUser }>;
  cleanupSessions(input: CleanupSessionsInput): Promise<CleanupSessionsResult>;
};
