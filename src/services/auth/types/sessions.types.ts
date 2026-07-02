import type { AuthUser } from './user.types.js';

export type Session = {
  id: string;
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
