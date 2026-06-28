import { Router, type RequestHandler } from 'express';
import { createAuthController } from '../controllers/auth.controller.js';
import {
  deleteAccountSchema,
  exportUserDataSchema,
  loginSchema,
  logoutAllSessionsSchema,
  logoutOtherSessionsSchema,
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
import type { AuthRoutePort } from '../services/auth.types.js';

type AuthRouterDependencies = {
  authService: AuthRoutePort;
  profileMediaMaxUploadBytes: number;
  authLimiter: RequestHandler;
  registrationIdentifierLimiter: RequestHandler;
  loginIdentifierLimiter: RequestHandler;
  verifyEmailIdentifierLimiter: RequestHandler;
  passwordResetEmailCooldown: RequestHandler;
  passwordResetIdentifierLimiter: RequestHandler;
  resetPasswordIdentifierLimiter: RequestHandler;
  resendVerificationEmailCooldown: RequestHandler;
  resendVerificationIdentifierLimiter: RequestHandler;
};

type ValidationSchema = Parameters<typeof validate>[0];

const createAuthRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  authLimiter,
  registrationIdentifierLimiter,
  loginIdentifierLimiter,
  verifyEmailIdentifierLimiter,
  passwordResetEmailCooldown,
  passwordResetIdentifierLimiter,
  resetPasswordIdentifierLimiter,
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
  const validateRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    validate(schema),
    ...handlers,
  ];
  const protectedValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect(),
    ...validateRoute(schema, ...handlers),
  ];
  const sessionValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    authenticateSession,
    ...validateRoute(schema, ...handlers),
  ];

  router.post(
    '/register',
    authLimiter,
    ...validateRoute(registerSchema, registrationIdentifierLimiter, register),
  );
  router.post('/login', authLimiter, ...validateRoute(loginSchema, loginIdentifierLimiter, login));
  router.post(
    '/verify-email',
    authLimiter,
    ...validateRoute(verifyEmailSchema, verifyEmailIdentifierLimiter, verifyEmail),
  );
  router.post(
    '/resend-verification',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
    }),
    ...validateRoute(
      resendVerificationSchema,
      resendVerificationIdentifierLimiter,
      resendVerificationEmailCooldown,
      resendVerification,
    ),
  );
  router.get('/me', ...protect(), me);
  router.post('/me/export', ...protectedValidatedRoute(exportUserDataSchema, exportMe));
  router.delete('/me', ...protectedValidatedRoute(deleteAccountSchema, deleteMe));
  router.patch('/me', ...protectedValidatedRoute(updateProfileSchema, updateMe));
  router.put('/me/avatar', ...protect(), uploadAvatarFile, uploadAvatar);
  router.delete('/me/avatar', ...protect(), deleteAvatar);
  router.put('/me/banner', ...protect(), uploadBannerFile, uploadBanner);
  router.delete('/me/banner', ...protect(), deleteBanner);
  router.get('/sessions', ...sessionValidatedRoute(userSessionsSchema, sessions));
  router.delete('/sessions/all', ...sessionValidatedRoute(logoutAllSessionsSchema, logoutAll));
  router.delete(
    '/sessions/others/all',
    ...sessionValidatedRoute(logoutOtherSessionsSchema, logoutOthers),
  );
  router.delete(
    '/sessions/:sessionId',
    ...sessionValidatedRoute(logoutSessionSchema, logoutSession),
  );
  router.post(
    '/forgot-password',
    authLimiter,
    ...protect({
      access: 'guest',
      conflictMessage: ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
    }),
    ...validateRoute(
      requestPasswordResetSchema,
      passwordResetIdentifierLimiter,
      passwordResetEmailCooldown,
      requestPasswordReset,
    ),
  );
  router.post(
    '/reset-password',
    authLimiter,
    ...validateRoute(resetPasswordSchema, resetPasswordIdentifierLimiter, resetPassword),
  );

  return router;
};

export const createRouter = createAuthRouter;
export { routeDocs } from '../docs/auth.routes.js';
