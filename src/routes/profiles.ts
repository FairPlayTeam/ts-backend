import { Router, type RequestHandler } from 'express';
import { createProfilesController } from '../controllers/profiles.controller.js';
import {
  followPublicProfileSchema,
  getPublicProfileSchema,
  listFollowingProfilesSchema,
  unfollowPublicProfileSchema,
} from '../controllers/profiles.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { validate } from '../middleware/validation.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import type { ProfilesRoutePort } from '../services/profiles.types.js';

type ProfilesRouterDependencies = {
  authService: AuthSessionValidationPort;
  profilesService: ProfilesRoutePort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({ authService, profilesService }: ProfilesRouterDependencies) => {
  const router = Router();
  const { followPublicProfile, getPublicProfile, listFollowingProfiles, unfollowPublicProfile } =
    createProfilesController({ profilesService });
  const protect = createRouteProtector({ authService });
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
  router.get('/:username', validate(getPublicProfileSchema), getPublicProfile);

  return router;
};

export { routeDocs } from '../docs/profiles.routes.js';
