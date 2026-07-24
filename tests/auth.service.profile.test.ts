import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import {
  AuthenticatedUserNotFoundError,
  ProfileUpdateEmptyError,
} from '../src/services/auth.errors.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from '../src/services/auth/auth.messages.js';
import { createTestDeps } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service profile', () => {
  test('returns profile data with signed profile media urls', async () => {
    const { deps, calls } = createTestDeps();
    const avatarObjectKey = 'users/user-id/avatar/current-avatar.webp';
    const bannerObjectKey = 'users/user-id/banner/current-banner.webp';
    const service = createAuthService({
      ...deps,
      prisma: {
        ...deps.prisma,
        user: {
          ...deps.prisma.user,
          findUnique: async (args: unknown) => {
            calls.userFindUnique = args;

            return {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: 'Definitely not an undercover Y**tube employee.',
              role: 'user',
              mediaAssets: [
                {
                  kind: 'avatar',
                  objectKey: avatarObjectKey,
                },
                {
                  kind: 'banner',
                  objectKey: bannerObjectKey,
                },
              ],
            };
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    await expect(
      service.getProfile({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
        role: 'user',
        avatarUrl: `http://localhost:9000/fairplay-user-media/${avatarObjectKey}`,
        bannerUrl: `http://localhost:9000/fairplay-user-media/${bannerObjectKey}`,
      },
    });

    expect(calls.userFindUnique).toEqual({
      where: { id: 'user-id' },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        mediaAssets: {
          where: {
            kind: {
              in: ['avatar', 'banner'],
            },
          },
          select: {
            bucket: true,
            kind: true,
            objectKey: true,
          },
        },
      },
    });
    expect(calls.signedUrlObjectKeys).toEqual([avatarObjectKey, bannerObjectKey]);
  });

  test('returns profile data with null media urls when no profile media exists', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService({
      ...deps,
      prisma: {
        ...deps.prisma,
        user: {
          ...deps.prisma.user,
          findUnique: async (args: unknown) => {
            calls.userFindUnique = args;

            return {
              id: 'user-id',
              email: 'user@example.com',
              username: 'fairplay_user',
              displayName: 'Fairplay User',
              bio: null,
              role: 'user',
              mediaAssets: [],
            };
          },
        },
      } as unknown as AuthDeps['prisma'],
    });

    await expect(
      service.getProfile({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
        avatarUrl: null,
        bannerUrl: null,
      },
    });

    expect(calls.signedUrlObjectKeys).toEqual([]);
  });

  test('rejects profile reads when the authenticated user disappeared', async () => {
    const { deps } = createTestDeps({
      prisma: {
        user: {
          findUnique: async () => null,
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.getProfile({
        userId: 'user-id',
      }),
    ).rejects.toBeInstanceOf(AuthenticatedUserNotFoundError);
  });

  test('updates profile fields for a user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.updateProfile({
        userId: 'user-id',
        displayName: 'Fairplay Creator',
        bio: null,
      }),
    ).resolves.toEqual({
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay Creator',
        bio: null,
        role: 'user',
      },
    });

    expect(calls.userUpdate).toEqual({
      where: { id: 'user-id' },
      data: {
        displayName: 'Fairplay Creator',
        bio: null,
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
      },
    });
  });

  test('rejects profile updates when the authenticated user disappeared', async () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const { deps } = createTestDeps({
      prisma: {
        user: {
          update: async () => {
            throw prismaError;
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.updateProfile({
        userId: 'user-id',
        displayName: 'Fairplay Creator',
      }),
    ).rejects.toBeInstanceOf(AuthenticatedUserNotFoundError);
  });

  test('rejects empty profile updates at the service boundary', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.updateProfile({
        userId: 'user-id',
      }),
    ).rejects.toBeInstanceOf(ProfileUpdateEmptyError);

    expect(calls.userUpdate).toBeUndefined();
  });
});
