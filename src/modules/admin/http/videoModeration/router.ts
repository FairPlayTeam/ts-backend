import { Router, type RequestHandler } from 'express';
import type { AuthSessionValidationPort } from '../../../../services/auth.types.js';
import { createRouteProtector } from '../../../../middleware/routeProtection.js';
import { validate } from '../../../../middleware/validation.js';
import { MODERATION_ROLES } from '../../authorization.js';
import type { VideoModerationPort } from '../../videoModeration/types.js';
import { createVideoModerationHandlers } from './handlers.js';
import { routeDocs } from './openapi.js';
import {
  adminVideosSchema,
  moderateAdminVideoSchema,
  requestAdminVideoDeletionSchema,
} from './schemas.js';

type VideoModerationRouterDependencies = {
  authService: AuthSessionValidationPort;
  videoModerationService: VideoModerationPort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  videoModerationService,
  authService,
}: VideoModerationRouterDependencies) => {
  const router = Router();
  const { listVideos, moderateVideo, requestVideoDeletion } = createVideoModerationHandlers({
    videoModerationService,
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

export { routeDocs };
