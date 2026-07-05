import type { ProfilesRoutePort } from '../../services/profiles.types.js';

export type ProfilesControllerDependencies = {
  profilesService: ProfilesRoutePort;
};
