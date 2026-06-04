import type { AuthService } from './auth.types.js';
import type { AuthDependencies } from './auth/auth.dependencies.js';
import { createVerificationService } from './auth/auth.emailVerification.js';
import { createRegistrationService } from './auth/auth.registration.js';
import { createSessionService } from './auth/auth.sessions.js';
import { createProfileService } from './auth/auth.profile.js';
import { createLoginService } from './auth/auth.login.js';
import { createResetPasswordService } from './auth/auth.resetPassword.js';
import { createTokenCleanupService } from './auth/auth.tokenCleanup.js';
import { createDataExportService } from './auth/auth.dataExport.js';

export const createAuthService = (deps: AuthDependencies): AuthService => {
  const sessionService = createSessionService(deps);

  return {
    ...createRegistrationService(deps),
    ...createLoginService(deps, sessionService),
    ...createVerificationService(deps, sessionService),
    ...createProfileService(deps),
    ...createResetPasswordService(deps),
    ...createTokenCleanupService(deps),
    ...createDataExportService(deps),
    validateSession: sessionService.validateSession,
    getUserSessions: sessionService.getUserSessions,
    logoutAllSessions: sessionService.logoutAllSessions,
    logoutOtherSessions: sessionService.logoutOtherSessions,
    logoutSession: sessionService.logoutSession,
    cleanupSessions: sessionService.cleanupSessions,
  };
};
