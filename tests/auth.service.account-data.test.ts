import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { AuthenticatedUserNotFoundError } from '../src/services/auth.errors.js';
import { createTestDeps, createUserMediaDeletionJobMock, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service account data', () => {
  test('exports user data without selecting secret fields', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.exportUserData({
        userId: 'user-id',
        currentSessionId: 'session-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      exportedAt: fixedNow,
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
        isVerified: true,
        isBanned: false,
        bannedAt: null,
        createdAt: fixedNow,
        updatedAt: fixedNow,
        lastLogin: fixedNow,
      },
      mediaAssets: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'avatar',
          objectKey: 'users/user-id/avatar/current-avatar.webp',
          mimeType: 'image/webp',
          sizeBytes: 1234,
          width: 512,
          height: 512,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'banner',
          objectKey: 'users/user-id/banner/current-banner.webp',
          mimeType: 'image/webp',
          sizeBytes: 2345,
          width: 1500,
          height: 500,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
      sessions: [
        {
          id: 'session-id',
          sessionKeySuffix: 'in-token',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          isActive: true,
          isCurrent: true,
          createdAt: fixedNow,
          updatedAt: fixedNow,
          lastUsedAt: fixedNow,
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        },
        {
          id: 'other-session-id',
          sessionKeySuffix: null,
          ipAddress: null,
          userAgent: null,
          deviceInfo: null,
          isActive: false,
          isCurrent: false,
          createdAt: fixedNow,
          updatedAt: fixedNow,
          lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        },
      ],
      emailVerificationToken: {
        id: 'verification-token-id',
        createdAt: fixedNow,
        expiresAt: new Date('2026-01-08T00:00:00.000Z'),
      },
      passwordResetToken: {
        id: 'password-reset-token-id',
        createdAt: fixedNow,
        expiresAt: new Date('2026-01-02T00:00:00.000Z'),
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
        isVerified: true,
        isBanned: true,
        bannedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        mediaAssets: {
          select: {
            id: true,
            kind: true,
            objectKey: true,
            mimeType: true,
            sizeBytes: true,
            width: true,
            height: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        },
        sessions: {
          select: {
            id: true,
            sessionKeySuffix: true,
            ipAddress: true,
            userAgent: true,
            deviceInfo: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        emailVerificationTokens: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
        passwordResetToken: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
    });

    const selectedFields = JSON.stringify(calls.userFindUnique);
    expect(selectedFields).not.toContain('"passwordHash":');
    expect(selectedFields).not.toContain('"sessionKey":');
    expect(selectedFields).not.toContain('"token":');
  });

  test('rejects data exports when the authenticated user disappeared after reauthentication', async () => {
    const { deps } = createTestDeps({
      prisma: {
        user: {
          findUnique: async (args: unknown) => {
            const select = (args as { select?: Record<string, unknown> }).select;

            if (select?.passwordHash) {
              return {
                passwordHash: 'hashed-password',
                isBanned: false,
              };
            }

            return null;
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.exportUserData({
        userId: 'user-id',
        currentSessionId: 'session-id',
        currentPassword: 'Password1!',
      }),
    ).rejects.toBeInstanceOf(AuthenticatedUserNotFoundError);
  });

  test('deletes user personal data for account deletion', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: 0,
    });
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
    });

    expect(calls.sessionDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.tokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { userId: 'user-id' },
    });
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
  });

  test('deletes stored media objects after deleting an account', async () => {
    const events: string[] = [];
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
          events.push('transaction');

          return callback({
            userMediaAsset: {
              findMany: async (args: unknown) => {
                calls.userMediaAssetFindMany = args;

                return [
                  { objectKey: 'users/user-id/avatar/current-avatar.webp' },
                  { objectKey: 'users/user-id/banner/current-banner.webp' },
                ];
              },
            },
            session: {
              deleteMany: async (args: unknown) => {
                calls.sessionDeleteMany = args;
              },
            },
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;
              },
            },
            passwordResetToken: {
              deleteMany: async (args: unknown) => {
                calls.passwordResetTokenDeleteMany = args;
              },
            },
            user: {
              deleteMany: async (args: unknown) => {
                calls.userDeleteMany = args;
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          });
        },
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async () => undefined,
        deleteObject: async (objectKey: string) => {
          events.push('deleteObject');
          calls.deleteObjects = [
            ...((calls.deleteObjects as string[] | undefined) ?? []),
            objectKey,
          ];
        },
        getSignedUrl: async (objectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${objectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: 0,
    });

    expect(calls.userMediaAssetFindMany).toEqual({
      where: { userId: 'user-id' },
      select: {
        objectKey: true,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [
        { objectKey: 'users/user-id/avatar/current-avatar.webp' },
        { objectKey: 'users/user-id/banner/current-banner.webp' },
      ],
      skipDuplicates: true,
    });
    expect(calls.deleteObjects).toEqual([
      'users/user-id/avatar/current-avatar.webp',
      'users/user-id/banner/current-banner.webp',
    ]);
    expect(events).toEqual(['transaction', 'deleteObject', 'deleteObject']);
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
  });

  test('keeps account deletion successful when media object cleanup fails', async () => {
    const cleanupError = new Error('object storage unavailable');
    const objectKeys = [
      'users/user-id/avatar/current-avatar.webp',
      'users/user-id/banner/current-banner.webp',
    ];
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findMany: async () => objectKeys.map((objectKey) => ({ objectKey })),
            },
            session: {
              deleteMany: async (args: unknown) => {
                calls.sessionDeleteMany = args;
              },
            },
            emailVerificationToken: {
              deleteMany: async (args: unknown) => {
                calls.tokenDeleteMany = args;
              },
            },
            passwordResetToken: {
              deleteMany: async (args: unknown) => {
                calls.passwordResetTokenDeleteMany = args;
              },
            },
            user: {
              deleteMany: async (args: unknown) => {
                calls.userDeleteMany = args;
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          }),
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async (input: unknown) => {
          calls.putObject = input;
        },
        deleteObject: async (objectKey: string) => {
          calls.deleteObjects = [
            ...((calls.deleteObjects as string[] | undefined) ?? []),
            objectKey,
          ];
          throw cleanupError;
        },
        getSignedUrl: async (objectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${objectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
      mediaCleanupQueued: objectKeys.length,
    });

    expect(calls.deleteObjects).toEqual(objectKeys);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: objectKeys.map((objectKey) => ({ objectKey })),
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey: objectKeys[1] },
      message:
        'Stored user media object cleanup failed after account deletion; cleanup remains queued',
    });
  });
});
