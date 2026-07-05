import { toIsoString } from '../http.responses.js';
import type { GetPublicProfileResult } from '../../services/profiles.types.js';

export const toPublicProfileResponse = ({ profile }: GetPublicProfileResult) => ({
  profile: {
    ...profile,
    createdAt: toIsoString(profile.createdAt),
  },
});
