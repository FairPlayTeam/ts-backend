import { createAccountDeletionService } from './account/deletion.js';
import { createDataExportService } from './account/dataExport.js';
import { createProfileService } from './account/profile.js';
import type { AuthProfilePort } from './account/types.js';
import { createLoginService } from './credentials/login.js';
import { createRegistrationService } from './credentials/registration.js';
import { createResetPasswordService } from './credentials/passwordReset.js';
import { createVerificationService } from './credentials/emailVerification.js';
import type { AuthDependencies } from './dependencies.js';
import { createMediaDeletionCleanupService } from './media/reconciliation.js';
import { createProfileMediaService } from './media/service.js';
import { createTokenCleanupService } from './maintenance/tokenCleanup.js';
import type { AuthAccountPort } from './account/types.js';
import type {
  AuthCredentialsPort,
  AuthEmailVerificationPort,
  AuthPasswordResetPort,
} from './credentials/types.js';
import type { AuthProfileMediaPort } from './media/types.js';
import type { AuthMaintenancePort } from './maintenance/types.js';
import type { AuthSessionManagementPort, AuthSessionValidationPort } from './sessions/types.js';
import { createSessionService } from './sessions/service.js';
import { authHttpModule } from './http/module.js';

export type AuthHttpPort = AuthCredentialsPort &
  AuthEmailVerificationPort &
  AuthPasswordResetPort &
  AuthProfilePort &
  AuthSessionManagementPort &
  AuthProfileMediaPort &
  AuthAccountPort;

export type AuthService = AuthHttpPort & AuthSessionValidationPort & AuthMaintenancePort;

export const createAuthService = (deps: AuthDependencies): AuthService => {
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

export { authHttpModule };
export type { AuthDependencies } from './dependencies.js';
export * from './errors.js';
export * from './messages.js';
export * from './roles.js';
export * from './authorization.js';
export type * from './account/types.js';
export type * from './credentials/types.js';
export type * from './maintenance/types.js';
export type * from './media/types.js';
export type * from './sessions/types.js';
