import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  RECONCILE_USER_MEDIA_TARGETS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { createTestDeps } from './support/authService.js';

describe('auth service cleanup', () => {
  test('cleans up expired and old inactive sessions', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);
    const expiredBefore = new Date('2026-01-01T00:00:00.000Z');
    const inactiveUpdatedBefore = new Date('2025-12-02T00:00:00.000Z');

    await expect(
      service.cleanupSessions({
        expiredBefore,
        inactiveUpdatedBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_SESSION_SUCCESS_MESSAGE,
      sessionsDeleted: 3,
    });

    expect(calls.sessionDeleteMany).toEqual({
      where: {
        OR: [
          { expiresAt: { lt: expiredBefore } },
          {
            isActive: false,
            updatedAt: { lt: inactiveUpdatedBefore },
          },
        ],
      },
    });
  });

  test('cleans up expired auth tokens', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);
    const expiredBefore = new Date('2026-01-01T00:00:00.000Z');

    await expect(
      service.cleanupExpiredAuthTokens({
        expiredBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
      emailVerificationTokensDeleted: 1,
      passwordResetTokensDeleted: 1,
    });

    expect(calls.tokenDeleteMany).toEqual({
      where: { expiresAt: { lt: expiredBefore } },
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: { expiresAt: { lt: expiredBefore } },
    });
  });

  test('scopes canonical cleanup to user-media targets', async () => {
    const { deps, calls } = createTestDeps({
      externalResources: {
        reconcileTarget: async () => 'skipped',
        reconcileDue: async (input: unknown) => {
          calls.reconcileDue = input;
          return {
            claimed: 3,
            confirmed: 2,
            redirectedAbsent: 0,
            failed: 1,
          };
        },
      },
    });
    const service = createAuthService(deps);

    await expect(service.reconcileUserMediaTargets({ limit: 12 })).resolves.toEqual({
      message: RECONCILE_USER_MEDIA_TARGETS_SUCCESS_MESSAGE,
      mediaTargetsConfirmed: 2,
      mediaTargetsFailed: 1,
    });
    expect(calls.reconcileDue).toEqual({
      roles: ['user_media'],
      limit: 12,
      handlers: {
        user_media: expect.objectContaining({
          preparePresent: expect.any(Function),
        }),
      },
    });
  });

  test('uses the canonical reconciler defaults when no limit is supplied', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await service.reconcileUserMediaTargets({});

    expect(calls.reconcileDue).toEqual({
      roles: ['user_media'],
      handlers: {
        user_media: expect.objectContaining({
          preparePresent: expect.any(Function),
        }),
      },
    });
  });
});
