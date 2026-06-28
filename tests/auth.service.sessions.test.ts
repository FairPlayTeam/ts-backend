import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import { InvalidCredentialsError } from '../src/services/auth.errors.js';
import {
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { createDefaultAuthPrisma, createTestDeps, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service sessions', () => {
  test('validates an active session and touches its last used timestamp', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(service.validateSession('plain-token')).resolves.toEqual({
      user: {
        id: 'user-id',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
      },
      session: {
        id: 'session-id',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      },
    });

    expect(calls.sessionFindUnique).toEqual({
      where: { sessionKey: 'hashed-plain-token' },
      select: {
        id: true,
        expiresAt: true,
        isActive: true,
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            displayName: true,
            bio: true,
            role: true,
            isBanned: true,
          },
        },
      },
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        id: 'session-id',
        lastUsedAt: {
          lt: new Date('2025-12-31T23:55:00.000Z'),
        },
      },
      data: { lastUsedAt: fixedNow },
    });
  });

  test('rejects missing sessions without touching last used timestamp', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        ...createDefaultAuthPrisma(),
        session: {
          findUnique: async () => null,
          update: async () => {
            throw new Error('Should not update a missing session');
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(service.validateSession('missing-token')).resolves.toBeNull();
    expect(calls.sessionUpdate).toBeUndefined();
  });

  test('rejects inactive, expired, and banned-user sessions', async () => {
    const invalidSessions = [
      {
        id: 'inactive-session',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        isActive: false,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: false,
        },
      },
      {
        id: 'expired-session',
        expiresAt: fixedNow,
        isActive: true,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: false,
        },
      },
      {
        id: 'banned-user-session',
        expiresAt: new Date('2026-01-31T00:00:00.000Z'),
        isActive: true,
        user: {
          id: 'user-id',
          email: 'user@example.com',
          username: 'fairplay_user',
          role: 'user',
          isBanned: true,
        },
      },
    ];

    for (const invalidSession of invalidSessions) {
      const { deps, calls } = createTestDeps({
        prisma: {
          ...createDefaultAuthPrisma(),
          session: {
            findUnique: async () => invalidSession,
            update: async () => {
              throw new Error('Should not update an invalid session');
            },
          },
        } as unknown as AuthDeps['prisma'],
      });
      const service = createAuthService(deps);

      await expect(service.validateSession('plain-token')).resolves.toBeNull();
      expect(calls.sessionUpdate).toBeUndefined();
    }
  });

  test('lists active user sessions and marks the current session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.getUserSessions({
        userId: 'user-id',
        currentSessionId: 'session-id',
      }),
    ).resolves.toEqual({
      sessions: [
        {
          id: 'session-id',
          sessionKeySuffix: 'in-token',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          createdAt: fixedNow,
          lastUsedAt: fixedNow,
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
          isCurrent: true,
        },
        {
          id: 'other-session-id',
          sessionKeySuffix: null,
          ipAddress: null,
          userAgent: null,
          deviceInfo: null,
          createdAt: fixedNow,
          lastUsedAt: new Date('2026-01-01T00:00:01.000Z'),
          expiresAt: new Date('2026-01-31T00:00:00.000Z'),
          isCurrent: false,
        },
      ],
      nextCursor: null,
      total: 2,
    });

    expect(calls.sessionFindMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        expiresAt: {
          gt: fixedNow,
        },
      },
      select: {
        id: true,
        sessionKeySuffix: true,
        ipAddress: true,
        userAgent: true,
        deviceInfo: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    expect(calls.sessionCount).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        expiresAt: {
          gt: fixedNow,
        },
      },
    });
  });

  test('caps active session list page size', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await service.getUserSessions({
      userId: 'user-id',
      currentSessionId: 'session-id',
      limit: 10_000,
    });

    expect(calls.sessionFindMany).toEqual(
      expect.objectContaining({
        take: 101,
      }),
    );
  });

  test('logs out all active user sessions', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.logoutAllSessions({ userId: 'user-id', currentPassword: 'Password1!' }),
    ).resolves.toEqual({
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });

    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });

  test('logs out other active user sessions while keeping the current session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.logoutOtherSessions({
        userId: 'user-id',
        currentSessionId: 'session-id',
        currentPassword: 'Password1!',
      }),
    ).resolves.toEqual({
      message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });

    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        userId: 'user-id',
        isActive: true,
        id: {
          not: 'session-id',
        },
      },
      data: {
        isActive: false,
      },
    });
  });

  test('rejects logging out other sessions when reauthentication fails', async () => {
    let comparedPassword: unknown;
    const { deps, calls } = createTestDeps({
      hasher: {
        hash: async () => 'hashed-password',
        compare: async (password: string, hash: string) => {
          comparedPassword = { password, hash };

          return false;
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.logoutOtherSessions({
        userId: 'user-id',
        currentSessionId: 'session-id',
        currentPassword: 'WrongPassword1!',
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    expect(comparedPassword).toEqual({
      password: 'WrongPassword1!',
      hash: 'hashed-password',
    });
    expect(calls.sessionUpdateMany).toBeUndefined();
  });

  test('logs out one active user session', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.logoutSession({
        userId: 'user-id',
        sessionId: 'target-session-id',
      }),
    ).resolves.toEqual({
      message: LOGOUT_SESSION_SUCCESS_MESSAGE,
      sessionsLoggedOut: 1,
    });

    expect(calls.sessionUpdateMany).toEqual({
      where: {
        id: 'target-session-id',
        userId: 'user-id',
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
  });
});
