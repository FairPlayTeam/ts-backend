import { Router, type RequestHandler } from 'express';
import { createAuthController } from '../controllers/auth.controller.js';
import {
  loginSchema,
  logoutSessionSchema,
  registerSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  updateProfileSchema,
  userSessionsSchema,
  verifyEmailSchema,
} from '../controllers/auth.schemas.js';
import { createAuthenticateSession } from '../middleware/auth.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { createSingleFileUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validation.js';
import {
  ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
  ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
} from '../services/auth/auth.messages.js';
import type { AuthService } from '../services/auth.types.js';

type AuthRouterDependencies = {
  authService: AuthService;
  profileMediaMaxUploadBytes: number;
  authLimiter: RequestHandler;
  registrationIdentifierLimiter: RequestHandler;
  loginIdentifierLimiter: RequestHandler;
  passwordResetEmailCooldown: RequestHandler;
  passwordResetIdentifierLimiter: RequestHandler;
  resendVerificationEmailCooldown: RequestHandler;
  resendVerificationIdentifierLimiter: RequestHandler;
};

const createAuthRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  authLimiter,
  registrationIdentifierLimiter,
  loginIdentifierLimiter,
  passwordResetEmailCooldown,
  passwordResetIdentifierLimiter,
  resendVerificationEmailCooldown,
  resendVerificationIdentifierLimiter,
}: AuthRouterDependencies) => {
  const router = Router();
  const {
    register,
    login,
    verifyEmail,
    resendVerification,
    me,
    updateMe,
    uploadAvatar,
    deleteAvatar,
    uploadBanner,
    deleteBanner,
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
    requestPasswordReset,
    resetPassword,
    exportMe,
    deleteMe,
  } = createAuthController({
    authService,
  });
  const authenticateSession = createAuthenticateSession({ authService });
  const protect = createRouteProtector({ authService });
  const uploadAvatarFile = createSingleFileUpload({
    fieldName: 'avatar',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });
  const uploadBannerFile = createSingleFileUpload({
    fieldName: 'banner',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });

  router.post(
    '/register',
    authLimiter,
    validate(registerSchema),
    registrationIdentifierLimiter,
    register,
  );
  router.post('/login', authLimiter, validate(loginSchema), loginIdentifierLimiter, login);
  router.post('/verify-email', authLimiter, validate(verifyEmailSchema), verifyEmail);
  router.post(
    '/resend-verification',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
    }),
    validate(resendVerificationSchema),
    resendVerificationIdentifierLimiter,
    resendVerificationEmailCooldown,
    resendVerification,
  );
  router.get('/me', ...protect(), me);
  router.get('/me/export', ...protect(), exportMe);
  router.delete('/me', ...protect(), deleteMe);
  router.patch('/me', ...protect(), validate(updateProfileSchema), updateMe);
  router.put('/me/avatar', ...protect(), uploadAvatarFile, uploadAvatar);
  router.delete('/me/avatar', ...protect(), deleteAvatar);
  router.put('/me/banner', ...protect(), uploadBannerFile, uploadBanner);
  router.delete('/me/banner', ...protect(), deleteBanner);
  router.get('/sessions', authenticateSession, validate(userSessionsSchema), sessions);
  router.delete('/sessions/all', authenticateSession, logoutAll);
  router.delete('/sessions/others/all', authenticateSession, logoutOthers);
  router.delete(
    '/sessions/:sessionId',
    authenticateSession,
    validate(logoutSessionSchema),
    logoutSession,
  );
  router.post(
    '/forgot-password',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
    }),
    validate(requestPasswordResetSchema),
    passwordResetIdentifierLimiter,
    passwordResetEmailCooldown,
    requestPasswordReset,
  );
  router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);

  return router;
};

export const createRouter = createAuthRouter;
export { routeDocs } from '../docs/auth.routes.js';
