import { toIsoString } from '../../../controllers/http.responses.js';
import type {
  FollowPublicProfileResult,
  GetPublicProfileResult,
  ListFollowingProfilesResult,
} from '../types.js';

const toPublicProfileBody = ({
  avatarUrl,
  bannerUrl,
  bio,
  createdAt,
  displayName,
  followerCount,
  followingCount,
  isFollowing,
  username,
}: GetPublicProfileResult['profile']) => ({
  username,
  displayName,
  bio,
  avatarUrl,
  bannerUrl,
  followerCount,
  followingCount,
  isFollowing,
  createdAt: toIsoString(createdAt),
});

export const toPublicProfileResponse = ({ profile }: GetPublicProfileResult) => ({
  profile: toPublicProfileBody(profile),
});

export const toFollowPublicProfileResponse = ({ message, profile }: FollowPublicProfileResult) => ({
  message,
  profile: toPublicProfileBody(profile),
});

export const toFollowingProfilesResponse = ({
  nextCursor,
  profiles,
  total,
}: ListFollowingProfilesResult) => ({
  profiles: profiles.map(({ avatarUrl, displayName, followedAt, username }) => ({
    username,
    displayName,
    avatarUrl,
    followedAt: toIsoString(followedAt),
  })),
  total,
  nextCursor,
});
