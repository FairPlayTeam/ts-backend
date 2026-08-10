import { Router, type RequestHandler } from 'express';
import { createAuthController } from '../controllers/auth.controller.js';
import {
  loginSchema,
  logoutSessionSchema,
  registerSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  sensitiveActionReauthenticationSchema,
  updateProfileSchema,
  userSessionsSchema,
  verifyEmailSchema,
} from '../controllers/auth.schemas.js';
import { createAuthenticateSession } from '../middleware/auth.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { createSingleFileUpload } from '../middleware/upload.js';
import type { UserAccountOperationGuard } from '../middleware/userAccountOperationGuard.js';
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
  profileMediaUploadLimiter: RequestHandler;
  expensiveAuthMutationLimiter: RequestHandler;
  registrationIdentifierLimiter: RequestHandler;
  loginIdentifierLimiter: RequestHandler;
  verifyEmailIdentifierLimiter: RequestHandler;
  passwordResetEmailCooldown: RequestHandler;
  passwordResetIdentifierLimiter: RequestHandler;
  resetPasswordIdentifierLimiter: RequestHandler;
  resendVerificationEmailCooldown: RequestHandler;
  resendVerificationIdentifierLimiter: RequestHandler;
  userAccountOperationGuard: UserAccountOperationGuard;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  authLimiter,
  profileMediaUploadLimiter,
  expensiveAuthMutationLimiter,
  registrationIdentifierLimiter,
  loginIdentifierLimiter,
  verifyEmailIdentifierLimiter,
  passwordResetEmailCooldown,
  passwordResetIdentifierLimiter,
  resetPasswordIdentifierLimiter,
  resendVerificationEmailCooldown,
  resendVerificationIdentifierLimiter,
  userAccountOperationGuard,
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
  router.post(
    '/me/export',
    ...protectedValidatedRoute(
      sensitiveActionReauthenticationSchema,
      expensiveAuthMutationLimiter,
      userAccountOperationGuard(exportMe),
    ),
  );
  router.delete(
    '/me',
    ...protectedValidatedRoute(
      sensitiveActionReauthenticationSchema,
      expensiveAuthMutationLimiter,
      userAccountOperationGuard(deleteMe),
    ),
  );
  router.patch('/me', ...protectedValidatedRoute(updateProfileSchema, updateMe));
  router.put('/me/avatar', ...protect(), profileMediaUploadLimiter, uploadAvatarFile, uploadAvatar);
  router.delete('/me/avatar', ...protect(), expensiveAuthMutationLimiter, deleteAvatar);
  router.put('/me/banner', ...protect(), profileMediaUploadLimiter, uploadBannerFile, uploadBanner);
  router.delete('/me/banner', ...protect(), expensiveAuthMutationLimiter, deleteBanner);
  router.get('/sessions', ...sessionValidatedRoute(userSessionsSchema, sessions));
  router.delete(
    '/sessions/all',
    ...sessionValidatedRoute(
      sensitiveActionReauthenticationSchema,
      expensiveAuthMutationLimiter,
      logoutAll,
    ),
  );
  router.delete(
    '/sessions/others/all',
    ...sessionValidatedRoute(
      sensitiveActionReauthenticationSchema,
      expensiveAuthMutationLimiter,
      logoutOthers,
    ),
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
export { routeDocs } from '../docs/auth.routes.js';
