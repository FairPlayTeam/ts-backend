import type { Prisma } from '@prisma/client';
import {
  profileMediaAssetSelect,
  profileMediaAssetWhere,
  toProfileMediaUrls,
} from '../userMedia/userMedia.profileAssets.js';
import { PublicProfileNotFoundError, SelfFollowError } from '../profiles.errors.js';
import type { ProfilesDependencies } from './profiles.dependencies.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from './profiles.messages.js';
import type {
  FollowPublicProfileInput,
  FollowPublicProfileResult,
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
  _count: {
    select: {
      followers: true,
      following: true,
    },
  },
} satisfies Prisma.UserSelect;

type PublicProfileRecord = Prisma.UserGetPayload<{ select: typeof publicProfileSelect }>;
type PublicProfileReader = Pick<ProfilesDependencies['prisma'], 'user'>;
type PublicProfileFollowStore = Pick<ProfilesDependencies['prisma'], 'user' | 'userFollow'>;
type PublicProfileFollowMutation = (
  prisma: PublicProfileFollowStore,
  followerId: string,
  followingId: string,
) => Promise<void>;

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const findPublicProfileRecord = (
  prisma: PublicProfileReader,
  where: Prisma.UserWhereInput,
): Promise<PublicProfileRecord | null> =>
  prisma.user.findFirst({
    where: {
      ...where,
      isVerified: true,
      isBanned: false,
    },
    select: publicProfileSelect,
  });

const toPublicProfile = async (
  deps: ProfilesDependencies,
  { _count, mediaAssets, ...profile }: PublicProfileRecord,
): Promise<PublicProfile> => {
  const { avatarUrl, bannerUrl } = await toProfileMediaUrls(deps.objectStorage, mediaAssets);

  return {
    ...profile,
    avatarUrl,
    bannerUrl,
    followerCount: _count.followers,
    followingCount: _count.following,
  };
};

const mutatePublicProfileFollow = async (
  deps: ProfilesDependencies,
  { actorUserId, username }: FollowPublicProfileInput,
  mutate: PublicProfileFollowMutation,
): Promise<PublicProfile> => {
  const normalizedUsername = normalizeUsername(username);
  const profile = await deps.prisma.$transaction(async (tx) => {
    const target = await findPublicProfileRecord(tx, { username: normalizedUsername });

    if (!target) {
      throw new PublicProfileNotFoundError();
    }

    if (target.id === actorUserId) {
      throw new SelfFollowError();
    }

    await mutate(tx, actorUserId, target.id);

    const updatedTarget = await findPublicProfileRecord(tx, { id: target.id });

    if (!updatedTarget) {
      throw new PublicProfileNotFoundError();
    }

    return updatedTarget;
  });

  return toPublicProfile(deps, profile);
};

export const createProfilesService = (deps: ProfilesDependencies): ProfilesPort => ({
  async getPublicProfile({ username }: GetPublicProfileInput): Promise<GetPublicProfileResult> {
    const profile = await findPublicProfileRecord(deps.prisma, {
      username: normalizeUsername(username),
    });

    if (!profile) {
      throw new PublicProfileNotFoundError();
    }

    return {
      profile: await toPublicProfile(deps, profile),
    };
  },

  async followPublicProfile(input: FollowPublicProfileInput): Promise<FollowPublicProfileResult> {
    const profile = await mutatePublicProfileFollow(
      deps,
      input,
      async (prisma, followerId, followingId) => {
        await prisma.userFollow.upsert({
          where: {
            followerId_followingId: {
              followerId,
              followingId,
            },
          },
          create: {
            followerId,
            followingId,
          },
          update: {},
        });
      },
    );

    return {
      message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile,
    };
  },

  async unfollowPublicProfile(input: FollowPublicProfileInput): Promise<FollowPublicProfileResult> {
    const profile = await mutatePublicProfileFollow(
      deps,
      input,
      async (prisma, followerId, followingId) => {
        await prisma.userFollow.deleteMany({
          where: {
            followerId,
            followingId,
          },
        });
      },
    );

    return {
      message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile,
    };
  },
});
