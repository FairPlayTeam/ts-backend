import type { Prisma } from '@prisma/client';
import {
  profileMediaAssetSelect,
  profileMediaAssetWhere,
  toStoredUserMediaAssetUrl,
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
  FollowingProfile,
  GetPublicProfileInput,
  GetPublicProfileResult,
  ListFollowingProfilesInput,
  ListFollowingProfilesResult,
  PublicProfile,
  ProfilesPort,
} from './types/profile.types.js';

const DEFAULT_FOLLOWING_PROFILES_LIMIT = 20;
const MAX_FOLLOWING_PROFILES_LIMIT = 100;

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

const followingProfileSelect = {
  createdAt: true,
  followingId: true,
  following: {
    select: {
      id: true,
      username: true,
      displayName: true,
      mediaAssets: {
        where: {
          kind: 'avatar',
        },
        select: profileMediaAssetSelect,
        take: 1,
      },
    },
  },
} satisfies Prisma.UserFollowSelect;

type FollowingProfileRecord = Prisma.UserFollowGetPayload<{
  select: typeof followingProfileSelect;
}>;

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const normalizeFollowingProfilesLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_FOLLOWING_PROFILES_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_FOLLOWING_PROFILES_LIMIT);
};

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

const toFollowingProfile = async (
  deps: ProfilesDependencies,
  { createdAt, following }: FollowingProfileRecord,
): Promise<FollowingProfile> => ({
  id: following.id,
  username: following.username,
  displayName: following.displayName,
  avatarUrl: await toStoredUserMediaAssetUrl(deps.objectStorage, following.mediaAssets[0]),
  followedAt: createdAt,
});

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

  async listFollowingProfiles({
    cursor,
    limit,
    userId,
  }: ListFollowingProfilesInput): Promise<ListFollowingProfilesResult> {
    const pageSize = normalizeFollowingProfilesLimit(limit);
    const resultFilter = {
      followerId: userId,
      following: {
        isVerified: true,
        isBanned: false,
      },
    } satisfies Prisma.UserFollowWhereInput;
    const pageFilter = {
      ...resultFilter,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.followedAt } },
              { createdAt: cursor.followedAt, followingId: { lt: cursor.id } },
            ],
          }
        : {}),
    } satisfies Prisma.UserFollowWhereInput;

    const [queriedFollows, total] = await deps.prisma.$transaction([
      deps.prisma.userFollow.findMany({
        where: pageFilter,
        select: followingProfileSelect,
        orderBy: [{ createdAt: 'desc' }, { followingId: 'desc' }],
        take: pageSize + 1,
      }),
      deps.prisma.userFollow.count({
        where: resultFilter,
      }),
    ]);

    const follows = queriedFollows.slice(0, pageSize);
    const lastFollow = follows.at(-1);
    const nextCursor =
      queriedFollows.length > pageSize && lastFollow
        ? { followedAt: lastFollow.createdAt, id: lastFollow.followingId }
        : null;

    return {
      profiles: await Promise.all(follows.map((follow) => toFollowingProfile(deps, follow))),
      total,
      nextCursor,
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
