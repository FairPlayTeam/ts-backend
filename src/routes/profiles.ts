import { Router, type RequestHandler } from 'express';
import { createProfilesController } from '../controllers/profiles.controller.js';
import {
  followPublicProfileSchema,
  getProfileMediaSchema,
  getPublicProfileSchema,
  listPublicProfileVideosSchema,
  listFollowingProfilesSchema,
  unfollowPublicProfileSchema,
} from '../controllers/profiles.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { createOptionalAuthenticateSession } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import type { ProfilesRoutePort } from '../services/profiles.types.js';
import type { VideosRoutePort } from '../services/videos.types.js';

type ProfilesRouterDependencies = {
  authService: AuthSessionValidationPort;
  profilesService: ProfilesRoutePort;
  videosService: Pick<VideosRoutePort, 'listPublicProfileVideos'>;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  authService,
  profilesService,
  videosService,
}: ProfilesRouterDependencies) => {
  const router = Router();
  const {
    followPublicProfile,
    getAvatar,
    getBanner,
    getPublicProfile,
    listPublicProfileVideos,
    listFollowingProfiles,
    unfollowPublicProfile,
  } = createProfilesController({ profilesService, videosService });
  const protect = createRouteProtector({ authService });
  const optionalAuthenticate = createOptionalAuthenticateSession({ authService });
  const protectedValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect(),
    validate(schema),
    ...handlers,
  ];

  router.get(
    '/me/following',
    ...protectedValidatedRoute(listFollowingProfilesSchema, listFollowingProfiles),
  );
  router.post(
    '/:username/follow',
    ...protectedValidatedRoute(followPublicProfileSchema, followPublicProfile),
  );
  router.delete(
    '/:username/follow',
    ...protectedValidatedRoute(unfollowPublicProfileSchema, unfollowPublicProfile),
  );
  router.get('/:username/avatar', validate(getProfileMediaSchema), getAvatar);
  router.get('/:username/banner', validate(getProfileMediaSchema), getBanner);
  router.get('/:username/videos', validate(listPublicProfileVideosSchema), listPublicProfileVideos);
  router.get(
    '/:username',
    validate(getPublicProfileSchema),
    optionalAuthenticate,
    getPublicProfile,
  );

  return router;
};

export { routeDocs } from '../docs/profiles.routes.js';
