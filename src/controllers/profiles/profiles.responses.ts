import { toIsoString } from '../http.responses.js';
import type {
  FollowPublicProfileResult,
  GetPublicProfileResult,
} from '../../services/profiles.types.js';

export const toPublicProfileResponse = ({ profile }: GetPublicProfileResult) => ({
  profile: {
    ...profile,
    createdAt: toIsoString(profile.createdAt),
  },
});

export const toFollowPublicProfileResponse = ({ message, profile }: FollowPublicProfileResult) => ({
  message,
  ...toPublicProfileResponse({ profile }),
});
