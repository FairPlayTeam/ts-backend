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

export const createStubAuthService = (): AuthService => ({
  register: async () => ({
    message: 'Account created. Please verify your email.',
  }),
  login: async () => sessionResult,
  verifyEmail: async () => ({
    ...sessionResult,
    message: 'Email successfully verified',
  }),
  resendVerification: async () => ({
    message: 'If this email exists and is unverified, a new link has been sent.',
  }),
});
