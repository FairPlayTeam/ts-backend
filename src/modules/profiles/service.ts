import type { Prisma } from '@prisma/client';
import {
  profileAvatarMediaAssetsSelection,
  profileMediaAssetSelect,
  profileMediaAssetWhere,
  toProfileMediaUrl,
  toProfileMediaUrls,
} from '../../services/userMedia/userMedia.profileAssets.js';
import {
  PublicProfileMediaNotFoundError,
  PublicProfileNotFoundError,
  SelfFollowError,
} from './errors.js';
import { readForProxy } from '../../services/assets/assetLinks.js';
import type { ProfilesDependencies } from './dependencies.js';
import { PUBLIC_PROFILE_VISIBILITY_SCOPE } from './publicVisibility.js';
import { FOLLOW_PROFILE_SUCCESS_MESSAGE, UNFOLLOW_PROFILE_SUCCESS_MESSAGE } from './constants.js';
import type {
  FollowPublicProfileInput,
  FollowPublicProfileResult,
  FollowingProfile,
  GetProfileMediaInput,
  GetProfileMediaResult,
  GetPublicProfileInput,
  GetPublicProfileResult,
  ListFollowingProfilesInput,
  ListFollowingProfilesResult,
  PublicProfile,
  ProfilesPort,
} from './types.js';

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
      username: true,
      displayName: true,
      mediaAssets: profileAvatarMediaAssetsSelection,
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
      ...PUBLIC_PROFILE_VISIBILITY_SCOPE,
    },
    select: publicProfileSelect,
  });

const toPublicProfile = (profile: PublicProfileRecord, isFollowing = false): PublicProfile => {
  const { avatarUrl, bannerUrl } = toProfileMediaUrls(profile.username, profile.mediaAssets);

  return {
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    createdAt: profile.createdAt,
    avatarUrl,
    bannerUrl,
    followerCount: profile._count.followers,
    followingCount: profile._count.following,
    isFollowing,
  };
};

const toFollowingProfile = ({
  createdAt,
  following,
}: FollowingProfileRecord): FollowingProfile => ({
  username: following.username,
  displayName: following.displayName,
  avatarUrl: toProfileMediaUrl(following.username, 'avatar', following.mediaAssets[0]),
  followedAt: createdAt,
});

const mutatePublicProfileFollow = async (
  deps: ProfilesDependencies,
  { actorUserId, username }: FollowPublicProfileInput,
  mutate: PublicProfileFollowMutation,
  isFollowing: boolean,
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

  return toPublicProfile(profile, isFollowing);
};

export const createProfilesService = (deps: ProfilesDependencies): ProfilesPort => ({
  async getProfileMedia({ kind, username }: GetProfileMediaInput): Promise<GetProfileMediaResult> {
    const asset = await deps.prisma.userMediaAsset.findFirst({
      where: {
        kind,
        user: {
          username: normalizeUsername(username),
          ...PUBLIC_PROFILE_VISIBILITY_SCOPE,
        },
      },
      select: {
        bucket: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
      },
    });

    if (!asset) {
      throw new PublicProfileMediaNotFoundError();
    }

    const body = await readForProxy(
      deps.objectStorage,
      asset,
      Math.min(asset.sizeBytes, deps.maxProxyBytes[kind]),
    );

    if (!body) {
      throw new PublicProfileMediaNotFoundError();
    }

    return {
      body,
      mimeType: asset.mimeType,
    };
  },

  async getPublicProfile({
    username,
    viewerUserId,
  }: GetPublicProfileInput): Promise<GetPublicProfileResult> {
    const profile = await findPublicProfileRecord(deps.prisma, {
      username: normalizeUsername(username),
    });

    if (!profile) {
      throw new PublicProfileNotFoundError();
    }

    const isFollowing =
      viewerUserId !== undefined && viewerUserId !== profile.id
        ? Boolean(
            await deps.prisma.userFollow.findUnique({
              where: {
                followerId_followingId: {
                  followerId: viewerUserId,
                  followingId: profile.id,
                },
              },
              select: { followingId: true },
            }),
          )
        : false;

    return {
      profileUserId: profile.id,
      profile: toPublicProfile(profile, isFollowing),
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
      true,
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
    const decodedCursor =
      cursor !== undefined ? deps.followingProfilesCursorCodec.decode(cursor) : undefined;
    const resultFilter = {
      followerId: userId,
      following: {
        isVerified: true,
        isBanned: false,
      },
    } satisfies Prisma.UserFollowWhereInput;
    const pageFilter = {
      ...resultFilter,
      ...(decodedCursor
        ? {
            OR: [
              { createdAt: { lt: decodedCursor.followedAt } },
              {
                createdAt: decodedCursor.followedAt,
                followingId: { lt: decodedCursor.id },
              },
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
        ? deps.followingProfilesCursorCodec.encode({
            followedAt: lastFollow.createdAt,
            id: lastFollow.followingId,
          })
        : null;

    return {
      profiles: follows.map(toFollowingProfile),
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
      false,
    );

    return {
      message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile,
    };
  },
});
