import { describe, expect, test } from 'bun:test';
import { createProfilesService } from '../src/services/profiles.service.js';
import { PublicProfileNotFoundError } from '../src/services/profiles.errors.js';
import type { ProfilesDependencies } from '../src/services/profiles/profiles.dependencies.js';

const profileCreatedAt = new Date('2026-01-01T00:00:00.000Z');

const createProfileRecord = ({
  mediaAssets = [
    {
      kind: 'avatar' as const,
      objectKey: 'users/user-id/avatar/current-avatar.webp',
    },
    {
      kind: 'banner' as const,
      objectKey: 'users/user-id/banner/current-banner.webp',
    },
  ],
} = {}) => ({
  id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
  username: 'fairplay_user',
  displayName: 'FairPlay User',
  bio: 'Sharing project updates with my subscribers.',
  createdAt: profileCreatedAt,
  mediaAssets,
});

const createDeps = ({ profile = createProfileRecord() }: { profile?: unknown | null } = {}) => {
  const calls: {
    signedUrlObjectKeys: string[];
    userFindFirst?: unknown;
  } = {
    signedUrlObjectKeys: [],
  };

  const deps: ProfilesDependencies = {
    prisma: {
      user: {
        findFirst: async (args: unknown) => {
          calls.userFindFirst = args;

          return profile;
        },
      },
    } as unknown as ProfilesDependencies['prisma'],
    objectStorage: {
      getSignedUrl: async (objectKey) => {
        calls.signedUrlObjectKeys.push(objectKey);

        return `signed:${objectKey}`;
      },
    },
  };

  return {
    calls,
    deps,
  };
};

describe('profiles service', () => {
  test('returns a public profile with signed profile media urls', async () => {
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
        avatarUrl: 'signed:users/user-id/avatar/current-avatar.webp',
        bannerUrl: 'signed:users/user-id/banner/current-banner.webp',
        createdAt: profileCreatedAt,
      },
    });

    expect(calls.userFindFirst).toEqual({
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
            kind: true,
            objectKey: true,
          },
        },
      },
    });
    expect(calls.signedUrlObjectKeys).toEqual([
      'users/user-id/avatar/current-avatar.webp',
      'users/user-id/banner/current-banner.webp',
    ]);
  });

  test('returns null profile media urls when no public media exists', async () => {
    const { calls, deps } = createDeps({
      profile: createProfileRecord({ mediaAssets: [] }),
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
    expect(calls.signedUrlObjectKeys).toEqual([]);
  });

  test('rejects missing or non-public profiles', async () => {
    const { calls, deps } = createDeps({ profile: null });

    await expect(
      createProfilesService(deps).getPublicProfile({
        username: 'fairplay_user',
      }),
    ).rejects.toBeInstanceOf(PublicProfileNotFoundError);
    expect(calls.signedUrlObjectKeys).toEqual([]);
  });
});
