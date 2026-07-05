export type GetPublicProfileInput = {
  username: string;
};

export type FollowPublicProfileInput = {
  actorUserId: string;
  username: string;
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

export type GetPublicProfileResult = {
  profile: PublicProfile;
};

export type FollowPublicProfileResult = {
  message: string;
  profile: PublicProfile;
};

export type ProfilesPort = {
  getPublicProfile: (input: GetPublicProfileInput) => Promise<GetPublicProfileResult>;
  followPublicProfile: (input: FollowPublicProfileInput) => Promise<FollowPublicProfileResult>;
  unfollowPublicProfile: (input: FollowPublicProfileInput) => Promise<FollowPublicProfileResult>;
};
