import type { AuthPorts } from './auth/types/ports.types.js';
import type { AuthDependencies } from './auth/auth.dependencies.js';
import { createVerificationService } from './auth/auth.emailVerification.js';
import { createRegistrationService } from './auth/auth.registration.js';
import { createSessionService } from './auth/auth.sessions.js';
import { createProfileService } from './auth/auth.profile.js';
import { createProfileMediaService } from './auth/auth.profileMedia.js';
import { createLoginService } from './auth/auth.login.js';
import { createResetPasswordService } from './auth/auth.resetPassword.js';
import { createTokenCleanupService } from './auth/auth.tokenCleanup.js';
import { createDataExportService } from './auth/auth.dataExport.js';
import { createAccountDeletionService } from './auth/auth.accountDeletion.js';
import { createMediaDeletionCleanupService } from './auth/auth.mediaDeletionCleanup.js';

export const createAuthService = (deps: AuthDependencies): AuthPorts => {
  const sessionService = createSessionService(deps);
  const registrationService = createRegistrationService(deps);
  const loginService = createLoginService(deps, sessionService);
  const verificationService = createVerificationService(deps, sessionService);
  const profileService = createProfileService(deps);
  const profileMediaService = createProfileMediaService(deps);
  const resetPasswordService = createResetPasswordService(deps);
  const tokenCleanupService = createTokenCleanupService(deps);
  const mediaDeletionCleanupService = createMediaDeletionCleanupService(deps);
  const dataExportService = createDataExportService(deps);
  const accountDeletionService = createAccountDeletionService(deps);

  return {
    ...registrationService,
    ...loginService,
    ...verificationService,
    ...resetPasswordService,
    ...profileService,
    ...profileMediaService,
    ...dataExportService,
    ...accountDeletionService,
    ...tokenCleanupService,
    ...sessionService,
    ...mediaDeletionCleanupService,
  };
};
