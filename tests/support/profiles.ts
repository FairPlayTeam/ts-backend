import type { ProfilesPorts } from '../../src/services/profiles.types.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';

const publicProfile = {
  id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
  username: 'fairplay_user',
  displayName: 'FairPlay User',
  bio: 'Sharing project updates with my subscribers.',
  avatarUrl: '/profiles/fairplay_user/avatar',
  bannerUrl: '/profiles/fairplay_user/banner',
  followerCount: 12,
  followingCount: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const followingProfile = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'followed_creator',
  displayName: 'Followed Creator',
  avatarUrl: '/profiles/followed_creator/avatar',
  followedAt: new Date('2026-01-02T00:00:00.000Z'),
};

export const createStubProfilesService = (): ProfilesPorts => ({
  getProfileMedia: async ({ kind }) => ({
    body: Buffer.from(`${kind}-bytes`),
    mimeType: 'image/webp',
  }),
  getPublicProfile: async () => ({
    profile: publicProfile,
  }),
  followPublicProfile: async () => ({
    message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
    profile: {
      ...publicProfile,
      followerCount: publicProfile.followerCount + 1,
    },
  }),
  unfollowPublicProfile: async () => ({
    message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
    profile: publicProfile,
  }),
  listFollowingProfiles: async () => ({
    profiles: [followingProfile],
    total: 1,
    nextCursor: null,
  }),
});
