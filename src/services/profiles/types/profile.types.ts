export type GetPublicProfileInput = {
  username: string;
};

export type PublicProfile = {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  createdAt: Date;
};

export type GetPublicProfileResult = {
  profile: PublicProfile;
};

export type ProfilesPort = {
  getPublicProfile: (input: GetPublicProfileInput) => Promise<GetPublicProfileResult>;
};
