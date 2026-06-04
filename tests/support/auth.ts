import type { AuthService } from '../../src/services/auth.types.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../../src/services/auth/auth.messages.js';

const sessionResult = {
  message: LOGIN_SUCCESS_MESSAGE,
  user: {
    id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    email: 'user@example.com',
    username: 'fairplay_user',
    displayName: 'Fairplay User',
    bio: 'Definitely not an undercover Y**tube employee.',
    role: 'user' as const,
  },
  sessionKey: 'test-session-key',
  session: {
    id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
  },
};

const userSessionsResult = {
  sessions: [
    {
      id: sessionResult.session.id,
      sessionKeySuffix: 'sion-key',
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
      deviceInfo: 'bun-test',
      isCurrent: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: sessionResult.session.expiresAt,
    },
  ],
  nextCursor: {
    lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
    id: sessionResult.session.id,
  },
  total: 1,
};

const userDataExportResult = {
  exportedAt: new Date('2026-01-01T00:00:00.000Z'),
  user: {
    ...sessionResult.user,
    isVerified: true,
    isBanned: false,
    bannedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLogin: new Date('2026-01-01T00:00:00.000Z'),
  },
  sessions: [
    {
      id: sessionResult.session.id,
      sessionKeySuffix: 'sion-key',
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
      deviceInfo: 'bun-test',
      isActive: true,
      isCurrent: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: sessionResult.session.expiresAt,
    },
  ],
  emailVerificationToken: null,
  passwordResetToken: null,
};

export const createStubAuthService = (): AuthService => ({
  register: async () => ({
    message: REGISTER_SUCCESS_MESSAGE,
  }),
  login: async () => sessionResult,
  verifyEmail: async () => ({
    ...sessionResult,
    message: VERIFY_EMAIL_SUCCESS_MESSAGE,
  }),
  validateSession: async () => ({
    user: sessionResult.user,
    session: sessionResult.session,
  }),
  resendVerification: async () => ({
    message: RESEND_VERIFICATION_EMAIL_MESSAGE,
  }),
  requestPasswordReset: async () => ({
    message: RESET_PASSWORD_EMAIL_MESSAGE,
  }),
  resetPassword: async () => ({
    message: RESET_PASSWORD_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  exportUserData: async () => userDataExportResult,
  deleteAccount: async () => ({
    message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
  }),
  getUserSessions: async () => userSessionsResult,
  logoutAllSessions: async () => ({
    message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  logoutOtherSessions: async () => ({
    message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  logoutSession: async () => ({
    message: LOGOUT_SESSION_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  updateProfile: async (input) => ({
    message: UPDATE_PROFILE_SUCCESS_MESSAGE,
    user: {
      ...sessionResult.user,
      displayName:
        input.displayName === undefined ? sessionResult.user.displayName : input.displayName,
      bio: input.bio === undefined ? sessionResult.user.bio : input.bio,
    },
  }),
  cleanupSessions: async () => ({
    message: CLEANUP_SESSION_SUCCESS_MESSAGE,
    sessionsDeleted: 0,
  }),
  cleanupExpiredAuthTokens: async () => ({
    message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
    emailVerificationTokensDeleted: 0,
    passwordResetTokensDeleted: 0,
  }),
});
