import type { AuthService } from '../../src/controllers/auth.controller.js';

const sessionResult = {
  message: 'Login successful',
  user: {
    id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    email: 'user@example.com',
    username: 'fairplay_user',
    role: 'user',
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
  total: 1,
};

export const createStubAuthService = (): AuthService => ({
  register: async () => ({
    message: 'Account created. Please verify your email.',
  }),
  login: async () => sessionResult,
  verifyEmail: async () => ({
    ...sessionResult,
    message: 'Email successfully verified',
  }),
  validateSession: async () => ({
    user: sessionResult.user,
    session: sessionResult.session,
  }),
  resendVerification: async () => ({
    message: 'If this email exists and is unverified, a new link has been sent.',
  }),
  getUserSessions: async () => userSessionsResult,
  logoutAllSessions: async () => ({
    message: 'All sessions logged out successfully',
    sessionsLoggedOut: 1,
  }),
  logoutOtherSessions: async () => ({
    message: 'Other sessions logged out successfully',
    sessionsLoggedOut: 1,
  }),
});
