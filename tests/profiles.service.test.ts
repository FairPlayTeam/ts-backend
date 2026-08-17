import { describe, expect, test } from 'bun:test';
import { createProfilesService } from '../src/services/profiles.service.js';
import {
  PublicProfileMediaNotFoundError,
  PublicProfileNotFoundError,
  SelfFollowError,
} from '../src/services/profiles.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../src/services/profiles/profiles.messages.js';
import type { ProfilesDependencies } from '../src/services/profiles/profiles.dependencies.js';

const profileCreatedAt = new Date('2026-01-01T00:00:00.000Z');
const firstFollowedAt = new Date('2026-01-04T00:00:00.000Z');
const secondFollowedAt = new Date('2026-01-03T00:00:00.000Z');
const thirdFollowedAt = new Date('2026-01-02T00:00:00.000Z');
const followerUserId = '11111111-1111-4111-8111-111111111111';

const createProfileRecord = ({
  id = '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
  followerCount = 12,
  followingCount = 3,
  mediaAssets = [
    {
      id: 'avatar-asset-id',
      kind: 'avatar' as const,
    },
    {
      id: 'banner-asset-id',
      kind: 'banner' as const,
    },
  ],
} = {}) => ({
  id,
  username: 'fairplay_user',
  displayName: 'FairPlay User',
  bio: 'Sharing project updates with my subscribers.',
  createdAt: profileCreatedAt,
  mediaAssets,
  _count: {
    followers: followerCount,
    following: followingCount,
  },
});

const createFollowingRecord = ({
  displayName = 'Followed User',
  followedAt,
  id,
  mediaAssets = [{ id: `avatar-${id}`, kind: 'avatar' as const }],
  username = `followed_${id.slice(0, 4)}`,
}: {
  displayName?: string | null;
  followedAt: Date;
  id: string;
  mediaAssets?: { id: string; kind: 'avatar' }[];
  username?: string;
}) => ({
  createdAt: followedAt,
  followingId: id,
  following: {
    id,
    username,
    displayName,
    mediaAssets,
  },
});

const createDeps = ({
  followingTotal = 3,
  followingLookup = null,
  maxProxyBytes = { avatar: 10, banner: 20 },
  profileMedia = {
    bucket: 'user-media',
    objectKey: 'users/user-id/avatar/current-avatar.webp',
    mimeType: 'image/webp',
    sizeBytes: 12,
  },
  profiles = [createProfileRecord()],
  queriedFollows = [
    createFollowingRecord({
      id: '33333333-3333-4333-8333-333333333333',
      followedAt: firstFollowedAt,
      displayName: 'First Followed',
    }),
    createFollowingRecord({
      id: '22222222-2222-4222-8222-222222222222',
      followedAt: secondFollowedAt,
      displayName: null,
      mediaAssets: [],
    }),
    createFollowingRecord({
      id: '11111111-1111-4111-8111-111111111111',
      followedAt: thirdFollowedAt,
      displayName: 'Extra Followed',
    }),
  ],
}: {
  followingTotal?: number;
  followingLookup?: { followingId: string } | null;
  maxProxyBytes?: ProfilesDependencies['maxProxyBytes'];
  profileMedia?: unknown;
  profiles?: unknown[] | unknown | null;
  queriedFollows?: ReturnType<typeof createFollowingRecord>[];
} = {}) => {
  const profileQueue = Array.isArray(profiles) ? [...profiles] : [profiles];
  const calls: {
    readObjectInputs: unknown[];
    transactionOperationCount?: number;
    transactionCount: number;
    userFindFirst: unknown[];
    userMediaAssetFindFirst: unknown[];
    userFollowCount?: unknown;
    userFollowDeleteMany?: unknown;
    userFollowFindMany?: unknown;
    userFollowFindUnique?: unknown;
    userFollowUpsert?: unknown;
  } = {
    readObjectInputs: [],
    transactionCount: 0,
    userFindFirst: [],
    userMediaAssetFindFirst: [],
  };
  const takeProfile = () => (profileQueue.length > 1 ? profileQueue.shift() : profileQueue[0]);

  const prisma = {
    user: {
      findFirst: async (args: unknown) => {
        calls.userFindFirst.push(args);

        return takeProfile();
      },
    },
    userFollow: {
      findUnique: async (args: unknown) => {
        calls.userFollowFindUnique = args;

        return followingLookup;
      },
      findMany: async (args: unknown) => {
        calls.userFollowFindMany = args;

        return queriedFollows;
      },
      count: async (args: unknown) => {
        calls.userFollowCount = args;

        return followingTotal;
      },
      upsert: async (args: unknown) => {
        calls.userFollowUpsert = args;

        return null;
      },
      deleteMany: async (args: unknown) => {
        calls.userFollowDeleteMany = args;

        return { count: 1 };
      },
    },
    userMediaAsset: {
      findFirst: async (args: unknown) => {
        calls.userMediaAssetFindFirst.push(args);

        return profileMedia;
      },
    },
    $transaction: async (input: unknown) => {
      calls.transactionCount += 1;

      if (Array.isArray(input)) {
        calls.transactionOperationCount = input.length;

        return Promise.all(input);
      }

      if (typeof input === 'function') {
        return input(prisma);
      }

      throw new Error('Unexpected profiles test transaction input');
    },
  };

  const deps: ProfilesDependencies = {
    prisma: prisma as unknown as ProfilesDependencies['prisma'],
    objectStorage: {
      readObject: async (input) => {
        calls.readObjectInputs.push(input);

        return Buffer.from('avatar-data');
      },
    },
    maxProxyBytes,
  };

  return {
    calls,
    deps,
  };
};

describe('profiles service', () => {
  test('reads public profile media through the user-media storage client with a bounded proxy read', async () => {
    const { calls, deps } = createDeps();

    await expect(
      createProfilesService(deps).getProfileMedia({
        username: ' FairPlay_User ',
        kind: 'avatar',
      }),
    ).resolves.toEqual({
      body: Buffer.from('avatar-data'),
      mimeType: 'image/webp',
    });
    expect(calls.userMediaAssetFindFirst).toEqual([
      {
        where: {
          kind: 'avatar',
          user: {
            username: 'fairplay_user',
          },
        },
        select: {
          bucket: true,
          objectKey: true,
          mimeType: true,
          sizeBytes: true,
        },
      },
    ]);
    expect(calls.readObjectInputs).toEqual([
      {
        bucket: 'user-media',
        objectKey: 'users/user-id/avatar/current-avatar.webp',
        maxBytes: 10,
      },
    ]);
    expect(calls.readObjectInputs).toHaveLength(1);
  });

  test('uses the media-kind ceiling even when the persisted banner size is larger', async () => {
    const { calls, deps } = createDeps({
      profileMedia: {
        bucket: 'user-media',
        objectKey: 'users/user-id/banner/current-banner.webp',
        mimeType: 'image/webp',
        sizeBytes: 30,
      },
    });

    await createProfilesService(deps).getProfileMedia({
      username: 'fairplay_user',
      kind: 'banner',
    });

    expect(calls.readObjectInputs).toEqual([
      {
        bucket: 'user-media',
        objectKey: 'users/user-id/banner/current-banner.webp',
        maxBytes: 20,
      },
    ]);
  });

  test('treats a missing profile-media row or stored object as not found', async () => {
    const missingRow = createDeps({ profileMedia: null });

    await expect(
      createProfilesService(missingRow.deps).getProfileMedia({
        username: 'fairplay_user',
        kind: 'banner',
      }),
    ).rejects.toBeInstanceOf(PublicProfileMediaNotFoundError);
    expect(missingRow.calls.readObjectInputs).toEqual([]);

    const missingObject = createDeps();
    missingObject.deps.objectStorage.readObject = async (input) => {
      missingObject.calls.readObjectInputs.push(input);

      return null;
    };

    await expect(
      createProfilesService(missingObject.deps).getProfileMedia({
        username: 'fairplay_user',
        kind: 'avatar',
      }),
    ).rejects.toBeInstanceOf(PublicProfileMediaNotFoundError);
  });

  test('returns a public profile with relative media paths based only on database presence', async () => {
    const { calls, deps } = createDeps();

    await expect(
      createProfilesService(deps).getPublicProfile({
        username: ' FairPlay_User ',
      }),
    ).resolves.toEqual({
      profile: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        bio: 'Sharing project updates with my subscribers.',
        avatarUrl: '/profiles/fairplay_user/avatar',
        bannerUrl: '/profiles/fairplay_user/banner',
        followerCount: 12,
        followingCount: 3,
        isFollowing: false,
        createdAt: profileCreatedAt,
      },
    });

    expect(calls.userFindFirst[0]).toEqual({
      where: {
        username: 'fairplay_user',
        isVerified: true,
        isBanned: false,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        createdAt: true,
        mediaAssets: {
          where: {
            kind: {
              in: ['avatar', 'banner'],
            },
          },
          select: {
            id: true,
            kind: true,
          },
        },
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });
    expect(calls.readObjectInputs).toEqual([]);
    expect(calls.userFollowFindUnique).toBeUndefined();
  });

  test('returns the authenticated viewer follow state without changing public access', async () => {
    const targetId = '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f';
    const { calls, deps } = createDeps({
      followingLookup: { followingId: targetId },
    });

    await expect(
      createProfilesService(deps).getPublicProfile({
        username: 'fairplay_user',
        viewerUserId: followerUserId,
      }),
    ).resolves.toMatchObject({
      profile: { isFollowing: true },
    });
    expect(calls.userFollowFindUnique).toEqual({
      where: {
        followerId_followingId: {
          followerId: followerUserId,
          followingId: targetId,
        },
      },
      select: { followingId: true },
    });
  });

  test('returns null profile media urls when no public media exists', async () => {
    const { calls, deps } = createDeps({
      profiles: createProfileRecord({ mediaAssets: [] }),
    });

    await expect(
      createProfilesService(deps).getPublicProfile({
        username: 'fairplay_user',
      }),
    ).resolves.toMatchObject({
      profile: {
        avatarUrl: null,
        bannerUrl: null,
      },
    });
    expect(calls.readObjectInputs).toEqual([]);
  });

  test('rejects missing or non-public profiles', async () => {
    const { calls, deps } = createDeps({ profiles: null });

    await expect(
      createProfilesService(deps).getPublicProfile({
        username: 'fairplay_user',
      }),
    ).rejects.toBeInstanceOf(PublicProfileNotFoundError);
    expect(calls.readObjectInputs).toEqual([]);
  });

  test('lists followed public profiles with stable cursor pagination and relative avatar paths', async () => {
    const { calls, deps } = createDeps();

    await expect(
      createProfilesService(deps).listFollowingProfiles({
        userId: followerUserId,
        limit: 2,
      }),
    ).resolves.toEqual({
      profiles: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          username: 'followed_3333',
          displayName: 'First Followed',
          avatarUrl: '/profiles/followed_3333/avatar',
          followedAt: firstFollowedAt,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          username: 'followed_2222',
          displayName: null,
          avatarUrl: null,
          followedAt: secondFollowedAt,
        },
      ],
      total: 3,
      nextCursor: {
        followedAt: secondFollowedAt,
        id: '22222222-2222-4222-8222-222222222222',
      },
    });

    const publicFollowingFilter = {
      followerId: followerUserId,
      following: {
        isVerified: true,
        isBanned: false,
      },
    };
    expect(calls.userFollowFindMany).toEqual({
      where: publicFollowingFilter,
      select: {
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
              select: {
                id: true,
                kind: true,
              },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { followingId: 'desc' }],
      take: 3,
    });
    expect(calls.userFollowCount).toEqual({
      where: publicFollowingFilter,
    });
    expect(calls.transactionOperationCount).toBe(2);
    expect(calls.readObjectInputs).toEqual([]);
  });

  test('applies followed profile cursor filtering and caps oversized limits', async () => {
    const { calls, deps } = createDeps({ queriedFollows: [] });
    const cursor = {
      followedAt: new Date('2026-01-10T00:00:00.000Z'),
      id: '99999999-9999-4999-8999-999999999999',
    };

    await createProfilesService(deps).listFollowingProfiles({
      userId: followerUserId,
      cursor,
      limit: 10_000,
    });

    expect(calls.userFollowFindMany).toEqual(
      expect.objectContaining({
        where: {
          followerId: followerUserId,
          following: {
            isVerified: true,
            isBanned: false,
          },
          OR: [
            { createdAt: { lt: cursor.followedAt } },
            { createdAt: cursor.followedAt, followingId: { lt: cursor.id } },
          ],
        },
        take: 101,
      }),
    );
  });

  test('follows a public profile idempotently and returns updated counts', async () => {
    const { calls, deps } = createDeps({
      profiles: [createProfileRecord(), createProfileRecord({ followerCount: 13 })],
    });

    await expect(
      createProfilesService(deps).followPublicProfile({
        actorUserId: '11111111-1111-4111-8111-111111111111',
        username: ' FairPlay_User ',
      }),
    ).resolves.toEqual({
      message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        bio: 'Sharing project updates with my subscribers.',
        avatarUrl: '/profiles/fairplay_user/avatar',
        bannerUrl: '/profiles/fairplay_user/banner',
        followerCount: 13,
        followingCount: 3,
        isFollowing: true,
        createdAt: profileCreatedAt,
      },
    });

    expect(calls.transactionCount).toBe(1);
    expect(calls.userFindFirst).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          username: 'fairplay_user',
          isVerified: true,
          isBanned: false,
        }),
      }),
      expect.objectContaining({
        where: expect.objectContaining({
          id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
          isVerified: true,
          isBanned: false,
        }),
      }),
    ]);
    expect(calls.userFollowUpsert).toEqual({
      where: {
        followerId_followingId: {
          followerId: '11111111-1111-4111-8111-111111111111',
          followingId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        },
      },
      create: {
        followerId: '11111111-1111-4111-8111-111111111111',
        followingId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      },
      update: {},
    });
  });

  test('unfollows a public profile idempotently', async () => {
    const { calls, deps } = createDeps({
      profiles: [createProfileRecord(), createProfileRecord({ followerCount: 11 })],
    });

    await expect(
      createProfilesService(deps).unfollowPublicProfile({
        actorUserId: '11111111-1111-4111-8111-111111111111',
        username: 'fairplay_user',
      }),
    ).resolves.toMatchObject({
      message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile: {
        followerCount: 11,
      },
    });

    expect(calls.userFollowDeleteMany).toEqual({
      where: {
        followerId: '11111111-1111-4111-8111-111111111111',
        followingId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      },
    });
  });

  test('rejects self-follow before mutating the relation', async () => {
    const { calls, deps } = createDeps();

    await expect(
      createProfilesService(deps).followPublicProfile({
        actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
      }),
    ).rejects.toBeInstanceOf(SelfFollowError);
    expect(calls.userFollowUpsert).toBeUndefined();
    expect(calls.userFollowDeleteMany).toBeUndefined();
    expect(calls.readObjectInputs).toEqual([]);
  });

  test('rejects follow mutations for missing or non-public profiles', async () => {
    const { calls, deps } = createDeps({ profiles: null });

    await expect(
      createProfilesService(deps).followPublicProfile({
        actorUserId: '11111111-1111-4111-8111-111111111111',
        username: 'missing_user',
      }),
    ).rejects.toBeInstanceOf(PublicProfileNotFoundError);
    expect(calls.userFollowUpsert).toBeUndefined();
    expect(calls.readObjectInputs).toEqual([]);
  });
});
