import { Router, type RequestHandler } from 'express';
import { createAdminController } from '../controllers/admin.controller.js';
import {
  adminVideosSchema,
  moderateAdminVideoSchema,
  requestAdminVideoDeletionSchema,
} from '../controllers/admin.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { validate } from '../middleware/validation.js';
import type { AdminRoutePort } from '../services/admin.types.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import { MODERATION_ROLES } from '../services/auth.roles.js';

type ModerationRouterDependencies = {
  authService: AuthSessionValidationPort;
  adminService: AdminRoutePort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({ adminService, authService }: ModerationRouterDependencies) => {
  const router = Router();
  const { listVideos, moderateVideo, requestVideoDeletion } = createAdminController({
    adminService,
  });
  const protect = createRouteProtector({ authService });
  const moderationRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect({ roles: MODERATION_ROLES }),
    validate(schema),
    ...handlers,
  ];

  router.get('/videos', ...moderationRoute(adminVideosSchema, listVideos));
  router.post(
    '/videos/:videoId/moderation',
    ...moderationRoute(moderateAdminVideoSchema, moderateVideo),
  );
  router.post(
    '/videos/:videoId/deletion',
    ...moderationRoute(requestAdminVideoDeletionSchema, requestVideoDeletion),
  );

  return router;
};

export { routeDocs } from '../docs/moderation.routes.js';
