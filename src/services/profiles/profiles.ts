import type { Prisma } from '@prisma/client';
import {
  profileMediaAssetSelect,
  profileMediaAssetWhere,
  toProfileMediaUrls,
} from '../userMedia/userMedia.profileAssets.js';
import { PublicProfileNotFoundError } from '../profiles.errors.js';
import type { ProfilesDependencies } from './profiles.dependencies.js';
import type {
  GetPublicProfileInput,
  GetPublicProfileResult,
  PublicProfile,
  ProfilesPort,
} from './types/profile.types.js';

const publicProfileSelect = {
  id: true,
  username: true,
  displayName: true,
  bio: true,
  createdAt: true,
  mediaAssets: {
    where: profileMediaAssetWhere,
    select: profileMediaAssetSelect,
  },
} satisfies Prisma.UserSelect;

type PublicProfileRecord = Prisma.UserGetPayload<{ select: typeof publicProfileSelect }>;

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const toPublicProfile = async (
  deps: ProfilesDependencies,
  { mediaAssets, ...profile }: PublicProfileRecord,
): Promise<PublicProfile> => {
  const { avatarUrl, bannerUrl } = await toProfileMediaUrls(deps.objectStorage, mediaAssets);

  return {
    ...profile,
    avatarUrl,
    bannerUrl,
  };
};

export const createProfilesService = (deps: ProfilesDependencies): ProfilesPort => ({
  async getPublicProfile({ username }: GetPublicProfileInput): Promise<GetPublicProfileResult> {
    const profile = await deps.prisma.user.findFirst({
      where: {
        username: normalizeUsername(username),
        isVerified: true,
        isBanned: false,
      },
      select: publicProfileSelect,
    });

    if (!profile) {
      throw new PublicProfileNotFoundError();
    }

    return {
      profile: await toPublicProfile(deps, profile),
    };
  },
});
