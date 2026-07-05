import { Router } from 'express';
import { createProfilesController } from '../controllers/profiles.controller.js';
import { getPublicProfileSchema } from '../controllers/profiles.schemas.js';
import { validate } from '../middleware/validation.js';
import type { ProfilesRoutePort } from '../services/profiles.types.js';

type ProfilesRouterDependencies = {
  profilesService: ProfilesRoutePort;
};

export const createRouter = ({ profilesService }: ProfilesRouterDependencies) => {
  const router = Router();
  const { getPublicProfile } = createProfilesController({ profilesService });

  router.get('/:username', validate(getPublicProfileSchema), getPublicProfile);

  return router;
};

export { routeDocs } from '../docs/profiles.routes.js';
