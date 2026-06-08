import { createAuthCredentialsController } from './auth/auth.credentials.controller.js';
import { createAuthMediaController } from './auth/auth.media.controller.js';
import { createAuthProfileController } from './auth/auth.profile.controller.js';
import { createAuthSessionsController } from './auth/auth.sessions.controller.js';
import type { AuthControllerDependencies } from './auth/auth.controller.types.js';

export const createAuthController = (deps: AuthControllerDependencies) => {
  const credentials = createAuthCredentialsController(deps);
  const profile = createAuthProfileController(deps);
  const media = createAuthMediaController(deps);
  const sessionController = createAuthSessionsController(deps);

  return {
    register: credentials.register,
    login: credentials.login,
    verifyEmail: credentials.verifyEmail,
    resendVerification: credentials.resendVerification,
    requestPasswordReset: credentials.requestPasswordReset,
    resetPassword: credentials.resetPassword,
    me: profile.me,
    exportMe: profile.exportMe,
    deleteMe: profile.deleteMe,
    updateMe: profile.updateMe,
    uploadAvatar: media.uploadAvatar,
    deleteAvatar: media.deleteAvatar,
    uploadBanner: media.uploadBanner,
    deleteBanner: media.deleteBanner,
    sessions: sessionController.sessions,
    logoutAll: sessionController.logoutAll,
    logoutOthers: sessionController.logoutOthers,
    logoutSession: sessionController.logoutSession,
  };
};
