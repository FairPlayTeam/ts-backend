import { Router, type RequestHandler } from 'express';
import { createAdminController } from '../controllers/admin.controller.js';
import { adminVideosSchema, moderateAdminVideoSchema } from '../controllers/admin.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { validate } from '../middleware/validation.js';
import type { AdminRoutePort } from '../services/admin.types.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';

type ModerationRouterDependencies = {
  authService: AuthSessionValidationPort;
  adminService: AdminRoutePort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({ adminService, authService }: ModerationRouterDependencies) => {
  const router = Router();
  const { listVideos, moderateVideo } = createAdminController({
    adminService,
  });
  const protect = createRouteProtector({ authService });
  const moderationRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect({ roles: ['moderator', 'admin'] }),
    validate(schema),
    ...handlers,
  ];

  router.get('/videos', ...moderationRoute(adminVideosSchema, listVideos));
  router.post(
    '/videos/:videoId/moderation',
    ...moderationRoute(moderateAdminVideoSchema, moderateVideo),
  );

  return router;
};

export { routeDocs } from '../docs/moderation.routes.js';
