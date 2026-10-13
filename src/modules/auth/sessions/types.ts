import type { AuthRole } from '../roles.js';

export const SESSION_PUBLIC_ID_PATTERN = /^(?:c[a-z0-9]{24}|s_[a-f0-9]{32})$/;
export const SESSION_PUBLIC_ID_EXAMPLE = 'cmbl7u2ag0000i6c2p5o9h9ta';

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: AuthRole;
};

export type AuthUserProfile = AuthUser & {
  avatarUrl: string | null;
  bannerUrl: string | null;
};

export type Session = {
  id: string;
  publicId: string;
  expiresAt: Date;
};

export type AuthSessionResult = {
  message: string;
  user: AuthUser;
  sessionKey: string;
  session: Session;
};

export type ValidatedAuthSession = {
  user: AuthUser;
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

export type ListUserSessionsInput = {
  userId: string;
  currentSessionId: string;
  cursor?: { lastUsedAt: Date; id: string };
  limit?: number;
};

export type ListUserSessionsResult = {
  sessions: UserSessionSummary[];
  total: number;
  nextCursor: {
    lastUsedAt: Date;
    id: string;
  } | null;
};

export type LogoutAllSessionsInput = {
  userId: string;
  currentPassword: string;
};

export type LogoutOtherSessionsInput = {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
};

export type LogoutSessionInput = {
  userId: string;
  sessionId: string;
};

export type CleanupSessionsInput = {
  expiredBefore: Date;
  inactiveUpdatedBefore: Date;
};

export type CleanupSessionsResult = {
  message: string;
  sessionsDeleted: number;
};

export type AuthSessionValidationPort = {
  validateSession: (sessionKey: string) => Promise<ValidatedAuthSession | null>;
};

export type AuthSessionManagementPort = {
  getUserSessions: (input: ListUserSessionsInput) => Promise<ListUserSessionsResult>;
  logoutAllSessions: (
    input: LogoutAllSessionsInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutOtherSessions: (
    input: LogoutOtherSessionsInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutSession: (
    input: LogoutSessionInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
};
