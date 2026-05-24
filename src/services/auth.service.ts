import type { AuthService } from './auth.types.js';
import type { AuthDependencies } from './auth/auth.dependencies.js';
import { createVerificationService } from './auth/auth.emailVerification.js';
import { createRegistrationService } from './auth/auth.registration.js';
import { createSessionService } from './auth/auth.sessions.js';
import { createProfileService } from './auth/auth.profile.js';
import { createLoginService } from './auth/auth.login.js';

export const createAuthService = (deps: AuthDependencies): AuthService => {
  const sessionService = createSessionService(deps);

  return {
    ...createRegistrationService(deps),
    ...createLoginService(deps, sessionService),
    ...createVerificationService(deps, sessionService),
    ...createProfileService(deps),
    validateSession: sessionService.validateSession,
    getUserSessions: sessionService.getUserSessions,
    logoutAllSessions: sessionService.logoutAllSessions,
    logoutOtherSessions: sessionService.logoutOtherSessions,
    logoutSession: sessionService.logoutSession,
    cleanupSessions: sessionService.cleanupSessions,
  };
};
