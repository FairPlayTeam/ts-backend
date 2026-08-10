import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { AuthenticatedUserNotFoundError } from '../src/services/auth.errors.js';
import { createTestDeps, fixedNow } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

const collectAsync = async <T>(values: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];

  for await (const value of values) {
    collected.push(value);
  }

  return collected;
};

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
    expect(await collectAsync(result.videoRatings)).toEqual([
      {
        videoId: '33333333-3333-4333-8333-333333333333',
        value: 5,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      },
    ]);
    expect(await collectAsync(result.videoViews)).toEqual([
      {
        videoId: '33333333-3333-4333-8333-333333333333',
        viewedOn: fixedNow,
      },
    ]);
    const comments = await collectAsync(result.comments);

    expect(comments).toEqual([
      {
        id: '44444444-4444-4444-8444-444444444444',
        videoId: '33333333-3333-4333-8333-333333333333',
        content: 'An exported comment.',
        createdAt: fixedNow,
        deletedAt: null,
        rootId: null,
        replyingToCommentId: null,
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        videoId: '33333333-3333-4333-8333-333333333333',
        content: null,
        createdAt: fixedNow,
        deletedAt: new Date('2026-01-01T01:00:00.000Z'),
        rootId: '44444444-4444-4444-8444-444444444444',
        replyingToCommentId: '44444444-4444-4444-8444-444444444444',
      },
    ]);
    expect(
      (await collectAsync(result.sessions)).map(({ id, isCurrent }) => ({ id, isCurrent })),
    ).toEqual([
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
      }),
    });
    expect(calls.videoRatingFindMany).toEqual([
      expect.objectContaining({ where: { userId: 'user-id' }, take: 250 }),
    ]);
    expect(calls.videoViewFindMany).toEqual([
      expect.objectContaining({ where: { userId: 'user-id' }, take: 250 }),
    ]);
    expect(calls.sessionFindMany).toEqual(
      expect.objectContaining({ where: { userId: 'user-id' }, take: 250 }),
    );
    expect(calls.commentFindMany).toEqual([
      {
        where: { authorId: 'user-id' },
        select: {
          id: true,
          videoId: true,
          content: true,
          createdAt: true,
          deletedAt: true,
          rootId: true,
          replyingToCommentId: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 250,
      },
    ]);
    expect(calls.comparedPassword).toEqual({
      password: 'Password1!',
      hash: 'hashed-password',
    });

    const selectedFields = JSON.stringify(calls.userFindUnique);
    expect(selectedFields).not.toContain('"comments":');
    expect(selectedFields).not.toContain('"videoRatings":');
    expect(selectedFields).not.toContain('"videoViews":');
    expect(selectedFields).not.toContain('"sessions":');
    expect(selectedFields).not.toContain('"passwordHash":');
    expect(selectedFields).not.toContain('"sessionKey":');
    expect(selectedFields).not.toContain('"token":');
  });

  test('iterates ratings, views, and sessions through the shared bounded keyset pattern', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      videoId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      createdAt: fixedNow,
      updatedAt: fixedNow,
      viewedOn: fixedNow,
      value: 5,
      sessionKeySuffix: null,
      ipAddress: null,
      userAgent: null,
      deviceInfo: null,
      isActive: true,
      lastUsedAt: fixedNow,
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    }));
    const ratingQueries: unknown[] = [];
    const viewQueries: unknown[] = [];
    const sessionQueries: unknown[] = [];
    let ratingOffset = 0;
    let viewOffset = 0;
    let sessionOffset = 0;
    const { deps } = createTestDeps({
      prisma: {
        videoRating: {
          findMany: async (args: unknown) => {
            ratingQueries.push(args);
            const page = rows.slice(ratingOffset, ratingOffset + 250);
            ratingOffset += page.length;
            return page;
          },
        },
        videoView: {
          findMany: async (args: unknown) => {
            viewQueries.push(args);
            const page = rows.slice(viewOffset, viewOffset + 250);
            viewOffset += page.length;
            return page;
          },
        },
        session: {
          findMany: async (args: unknown) => {
            sessionQueries.push(args);
            const page = rows.slice(sessionOffset, sessionOffset + 250);
            sessionOffset += page.length;
            return page;
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);
    const result = await service.exportUserData({
      userId: 'user-id',
      currentSessionId: rows[0]?.id ?? 'missing',
      currentPassword: 'Password1!',
    });

    expect(await collectAsync(result.videoRatings)).toHaveLength(501);
    expect(await collectAsync(result.videoViews)).toHaveLength(501);
    const sessions = await collectAsync(result.sessions);
    expect(sessions).toHaveLength(501);
    expect(sessions[0]?.isCurrent).toBe(true);

    for (const queries of [ratingQueries, viewQueries, sessionQueries]) {
      expect(queries).toHaveLength(3);
      expect(queries.map((query) => (query as { take?: number }).take)).toEqual([250, 250, 250]);
    }
    expect(ratingQueries[1]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-id',
          createdAt: { gte: fixedNow },
          OR: expect.any(Array),
        }),
      }),
    );
    expect(viewQueries[1]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-id',
          viewedOn: { gte: fixedNow },
          OR: expect.any(Array),
        }),
      }),
    );
    expect(sessionQueries[1]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-id',
          createdAt: { gte: fixedNow },
          OR: expect.any(Array),
        }),
      }),
    );
  });

  test('iterates large comment exports through bounded keyset pages', async () => {
    const exportedComments = Array.from({ length: 2_501 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      videoId: '33333333-3333-4333-8333-333333333333',
      content: `Exported comment ${index}`,
      createdAt: fixedNow,
      deletedAt: null,
      rootId: null,
      replyingToCommentId: null,
    }));
    const commentQueries: unknown[] = [];
    let offset = 0;
    const { deps } = createTestDeps({
      prisma: {
        comment: {
          findMany: async (args: unknown) => {
            commentQueries.push(args);
            const page = exportedComments.slice(offset, offset + 250);
            offset += page.length;
            return page;
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);
    const result = await service.exportUserData({
      userId: 'user-id',
      currentSessionId: 'session-id',
      currentPassword: 'Password1!',
    });
    const receivedIds: string[] = [];

    for await (const comment of result.comments) {
      receivedIds.push(comment.id);
    }

    expect(receivedIds).toEqual(exportedComments.map(({ id }) => id));
    expect(commentQueries).toHaveLength(11);
    expect(commentQueries.map((query) => (query as { take?: number }).take)).toEqual(
      Array.from({ length: 11 }, () => 250),
    );
    expect(commentQueries[1]).toEqual(
      expect.objectContaining({
        where: {
          authorId: 'user-id',
          createdAt: { gte: fixedNow },
          OR: [
            { createdAt: { gt: fixedNow } },
            {
              createdAt: fixedNow,
              id: { gt: exportedComments[249]?.id },
            },
          ],
        },
      }),
    );
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

  test('repairs denormalized aggregates then deletes the user row for database cascades', async () => {
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
    expect(calls.commentUpdateMany).toEqual({
      where: {
        authorId: 'user-id',
        deletedAt: null,
      },
      data: {
        content: null,
        deletedAt: fixedNow,
      },
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
