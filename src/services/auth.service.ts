import type { AuthPorts } from './auth.types.js';
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
    register: registrationService.register,
    login: loginService.login,
    verifyEmail: verificationService.verifyEmail,
    resendVerification: verificationService.resendVerification,
    requestPasswordReset: resetPasswordService.requestPasswordReset,
    resetPassword: resetPasswordService.resetPassword,
    getProfile: profileService.getProfile,
    updateProfile: profileService.updateProfile,
    uploadAvatar: profileMediaService.uploadAvatar,
    deleteAvatar: profileMediaService.deleteAvatar,
    uploadBanner: profileMediaService.uploadBanner,
    deleteBanner: profileMediaService.deleteBanner,
    exportUserData: dataExportService.exportUserData,
    deleteAccount: accountDeletionService.deleteAccount,
    cleanupExpiredAuthTokens: tokenCleanupService.cleanupExpiredAuthTokens,
    validateSession: sessionService.validateSession,
    getUserSessions: sessionService.getUserSessions,
    logoutAllSessions: sessionService.logoutAllSessions,
    logoutOtherSessions: sessionService.logoutOtherSessions,
    logoutSession: sessionService.logoutSession,
    cleanupSessions: sessionService.cleanupSessions,
    cleanupPendingUserMediaDeletions: mediaDeletionCleanupService.cleanupPendingUserMediaDeletions,
  };
};
