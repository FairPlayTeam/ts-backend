import type { ProfilesPort } from '../../src/modules/profiles/index.js';

export const EXPECTED_FOLLOW_PROFILE_SUCCESS_MESSAGE = 'Profile followed successfully';
export const EXPECTED_UNFOLLOW_PROFILE_SUCCESS_MESSAGE = 'Profile unfollowed successfully';
export const EXPECTED_INVALID_FOLLOWING_PROFILES_CURSOR_MESSAGE = 'Invalid pagination cursor';
export const EXPECTED_PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE = 'Profile media not found';
export const EXPECTED_SELF_FOLLOW_MESSAGE = 'Profiles cannot follow themselves';

const publicProfile = {
  username: 'fairplay_user',
  displayName: 'FairPlay User',
  bio: 'Sharing project updates with my subscribers.',
  avatarUrl: '/profiles/fairplay_user/avatar',
  bannerUrl: '/profiles/fairplay_user/banner',
  followerCount: 12,
  followingCount: 3,
  isFollowing: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const followingProfile = {
  username: 'followed_creator',
  displayName: 'Followed Creator',
  avatarUrl: '/profiles/followed_creator/avatar',
  followedAt: new Date('2026-01-02T00:00:00.000Z'),
};

export const createStubProfilesService = (): ProfilesPort => ({
  getProfileMedia: async ({ kind }) => ({
    body: Buffer.from(`${kind}-bytes`),
    mimeType: 'image/webp',
  }),
  getPublicProfile: async () => ({
    profileUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    profile: publicProfile,
  }),
  followPublicProfile: async () => ({
    message: EXPECTED_FOLLOW_PROFILE_SUCCESS_MESSAGE,
    profile: {
      ...publicProfile,
      followerCount: publicProfile.followerCount + 1,
      isFollowing: true,
    },
  }),
  unfollowPublicProfile: async () => ({
    message: EXPECTED_UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
    profile: { ...publicProfile, isFollowing: false },
  }),
  listFollowingProfiles: async () => ({
    profiles: [followingProfile],
    total: 1,
    nextCursor: null,
  }),
});
