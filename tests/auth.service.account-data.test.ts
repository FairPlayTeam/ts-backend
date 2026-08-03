import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { AuthenticatedUserNotFoundError } from '../src/services/auth.errors.js';
import { createTestDeps, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service account data', () => {
  test('exports user data without selecting secret fields', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.exportUserData({
      userId: 'user-id',
      currentSessionId: 'session-id',
      currentPassword: 'Password1!',
    });

    expect(result.exportedAt).toEqual(fixedNow);
    expect(result.mediaAssets).toEqual([
      expect.objectContaining({
        kind: 'avatar',
        url: '/profiles/fairplay_user/avatar',
      }),
      expect.objectContaining({
        kind: 'banner',
        url: '/profiles/fairplay_user/banner',
      }),
    ]);
    expect(JSON.stringify(result.mediaAssets)).not.toContain('objectKey');
    expect(JSON.stringify(result.mediaAssets)).not.toContain('bucket');
    expect(result.videoRatings).toEqual([
      {
        videoId: '33333333-3333-4333-8333-333333333333',
        value: 5,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ]);
    expect(result.sessions.map(({ id, isCurrent }) => ({ id, isCurrent }))).toEqual([
      { id: 'session-id', isCurrent: true },
      { id: 'other-session-id', isCurrent: false },
    ]);

    expect(calls.userFindUnique).toEqual({
      where: { id: 'user-id' },
      select: expect.objectContaining({
        mediaAssets: {
          select: {
            id: true,
            kind: true,
            mimeType: true,
            sizeBytes: true,
            width: true,
            height: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        },
        videoRatings: {
          select: {
            videoId: true,
            value: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { videoId: 'asc' }],
        },
      }),
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

  test('deletes only the user row and relies on database cascades for account data', async () => {
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
      externalCleanupQueued: 0,
    });

    expect(calls.userDeleteMany).toEqual({
      where: { id: 'user-id' },
    });
    expect(calls.sessionDeleteMany).toBeUndefined();
    expect(calls.tokenDeleteMany).toBeUndefined();
    expect(calls.passwordResetTokenDeleteMany).toBeUndefined();
  });

  test('schedules every external resource before deleting the account', async () => {
    const targets = [
      { id: 'source-target', role: 'source' as const },
      { id: 'media-target', role: 'user_media' as const },
    ];
    const targetIds = targets.map(({ id }) => id);
    const reconciledTargetIds: string[] = [];
    const { deps, calls } = createTestDeps({
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          reconciledTargetIds.push(targetId);
          return 'skipped';
        },
      },
    });
    calls.externalResourceTargets = targets;
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
      mediaCleanupQueued: 1,
      externalCleanupQueued: 2,
    });

    expect(calls.externalResourceTargetFindMany).toEqual({
      where: {
        userId: 'user-id',
        state: { not: 'confirmed_absent' },
      },
      select: { id: true, role: true },
    });
    expect(calls.externalResourceTargetUpdates).toHaveLength(2);
    expect(calls.externalResourceTargetUpdates).toEqual(
      expect.arrayContaining(
        targetIds.map((id) =>
          expect.objectContaining({
            where: { id },
            data: expect.objectContaining({
              goal: 'absent',
              state: 'quiescing',
              quiescenceNotBefore: new Date('2026-01-01T01:00:00.000Z'),
            }),
          }),
        ),
      ),
    );
    expect(calls.userDeleteMany).toEqual({ where: { id: 'user-id' } });
    expect(reconciledTargetIds).toEqual(['media-target']);
  });

  test('keeps account deletion successful when immediate reconciliation fails', async () => {
    const cleanupError = new Error('object storage unavailable');
    const { deps, calls } = createTestDeps({
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async () => {
          throw cleanupError;
        },
      },
    });
    calls.externalResourceTargets = [{ id: 'media-target', role: 'user_media' }];
    const service = createAuthService(deps);

    await expect(
      service.deleteAccount({
        userId: 'user-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
      mediaCleanupQueued: 1,
      externalCleanupQueued: 1,
    });
    expect(calls.warning).toEqual({
      data: {
        err: cleanupError,
        targetId: 'media-target',
        userId: 'user-id',
      },
      message: 'Immediate external resource reconciliation failed after account deletion',
    });
  });
});
