import type { UserMediaKind } from '../../userMedia/userMedia.types.js';

export type GetPublicProfileInput = {
  username: string;
};

export type GetProfileMediaInput = GetPublicProfileInput & {
  kind: UserMediaKind;
};

export type GetProfileMediaResult = {
  body: Buffer;
  mimeType: string;
};

export type FollowPublicProfileInput = {
  actorUserId: string;
  username: string;
};

export type ListFollowingProfilesInput = {
  userId: string;
  cursor?: {
    followedAt: Date;
    id: string;
  };
  limit?: number;
};

export type PublicProfile = {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  followerCount: number;
  followingCount: number;
  createdAt: Date;
};

export type FollowingProfile = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  followedAt: Date;
};

export type GetPublicProfileResult = {
  profile: PublicProfile;
};

export type FollowPublicProfileResult = {
  message: string;
  profile: PublicProfile;
};

export type ListFollowingProfilesResult = {
  profiles: FollowingProfile[];
  total: number;
  nextCursor: {
    followedAt: Date;
    id: string;
  } | null;
};

export type ProfilesPort = {
  getProfileMedia: (input: GetProfileMediaInput) => Promise<GetProfileMediaResult>;
  getPublicProfile: (input: GetPublicProfileInput) => Promise<GetPublicProfileResult>;
  followPublicProfile: (input: FollowPublicProfileInput) => Promise<FollowPublicProfileResult>;
  listFollowingProfiles: (
    input: ListFollowingProfilesInput,
  ) => Promise<ListFollowingProfilesResult>;
  unfollowPublicProfile: (input: FollowPublicProfileInput) => Promise<FollowPublicProfileResult>;
};
