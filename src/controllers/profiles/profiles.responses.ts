import { toIsoString } from '../http.responses.js';
import type {
  FollowPublicProfileResult,
  GetPublicProfileResult,
  ListFollowingProfilesResult,
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

export const toFollowingProfilesResponse = ({
  nextCursor,
  profiles,
  total,
}: ListFollowingProfilesResult) => ({
  profiles: profiles.map((profile) => ({
    ...profile,
    followedAt: toIsoString(profile.followedAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        followedAt: toIsoString(nextCursor.followedAt),
        id: nextCursor.id,
      }
    : null,
});
