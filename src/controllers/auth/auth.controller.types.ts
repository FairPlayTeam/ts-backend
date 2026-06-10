import type { AuthService } from '../../services/auth.types.js';

export type AuthControllerDependencies = {
  authService: Omit<
    AuthService,
    'cleanupExpiredAuthTokens' | 'cleanupPendingUserMediaDeletions' | 'cleanupSessions'
  >;
};
