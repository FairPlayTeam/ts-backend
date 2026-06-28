import { describe, expect, test } from 'bun:test';
import { createAuthService } from '../src/services/auth.service.js';
import {
  CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
  CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
  CLEANUP_SESSION_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { createTestDeps, createUserMediaDeletionJobMock } from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

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
      where: {
        expiresAt: {
          lt: expiredBefore,
        },
      },
    });
    expect(calls.passwordResetTokenDeleteMany).toEqual({
      where: {
        expiresAt: {
          lt: expiredBefore,
        },
      },
    });
  });

  test('cleans up queued user media object deletions', async () => {
    const deletedObjectKeys: string[] = [];
    const pendingBefore = new Date('2026-01-01T00:00:00.000Z');
    const jobs = [
      {
        id: 'media-deletion-job-1',
        objectKey: 'users/user-id/avatar/old-avatar.webp',
        attempts: 0,
      },
      {
        id: 'media-deletion-job-2',
        objectKey: 'users/user-id/banner/old-banner.webp',
        attempts: 1,
      },
    ];
    const deletedJobIds: string[] = [];
    const { deps, calls } = createTestDeps();
    const mutablePrisma = deps.prisma as unknown as {
      userMediaDeletionJob: AuthDeps['prisma']['userMediaDeletionJob'];
    };
    mutablePrisma.userMediaDeletionJob = {
      ...createUserMediaDeletionJobMock(calls),
      findMany: async (args: unknown) => {
        calls.userMediaDeletionJobFindMany = args;

        return jobs;
      },
      deleteMany: async (args: unknown) => {
        const id = (args as { where?: { id?: string } }).where?.id;

        if (id) {
          deletedJobIds.push(id);
        }

        return { count: 1 };
      },
    } as unknown as AuthDeps['prisma']['userMediaDeletionJob'];
    deps.objectStorage.deleteObject = async (objectKey: string) => {
      deletedObjectKeys.push(objectKey);
    };
    const service = createAuthService(deps);

    await expect(
      service.cleanupPendingUserMediaDeletions({
        pendingBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
      mediaObjectsDeleted: 2,
      mediaObjectDeletionJobsFailed: 0,
    });

    expect(calls.userMediaDeletionJobFindMany).toEqual({
      where: {
        nextAttemptAt: {
          lte: pendingBefore,
        },
      },
      select: {
        id: true,
        objectKey: true,
        attempts: true,
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
    expect(deletedObjectKeys).toEqual(jobs.map((job) => job.objectKey));
    expect(deletedJobIds).toEqual(jobs.map((job) => job.id));
  });

  test('reschedules queued user media object deletions when object storage fails', async () => {
    const cleanupError = new Error('object storage unavailable');
    const pendingBefore = new Date('2025-12-31T23:00:00.000Z');
    const job = {
      id: 'media-deletion-job-id',
      objectKey: 'users/user-id/avatar/old-avatar.webp',
      attempts: 2,
    };
    const { deps, calls } = createTestDeps();
    const mutablePrisma = deps.prisma as unknown as {
      userMediaDeletionJob: AuthDeps['prisma']['userMediaDeletionJob'];
    };
    mutablePrisma.userMediaDeletionJob = {
      ...createUserMediaDeletionJobMock(calls),
      findMany: async () => [job],
    } as unknown as AuthDeps['prisma']['userMediaDeletionJob'];
    deps.objectStorage.deleteObject = async () => {
      throw cleanupError;
    };
    const service = createAuthService(deps);

    await expect(
      service.cleanupPendingUserMediaDeletions({
        pendingBefore,
      }),
    ).resolves.toEqual({
      message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
      mediaObjectsDeleted: 0,
      mediaObjectDeletionJobsFailed: 1,
    });

    expect(calls.userMediaDeletionJobUpdateMany).toEqual({
      where: {
        id: job.id,
      },
      data: {
        attempts: 3,
        lastError: cleanupError.message,
        nextAttemptAt: new Date('2026-01-01T00:04:00.000Z'),
      },
    });
    expect(calls.warning).toEqual({
      data: { err: cleanupError, objectKey: job.objectKey, attempts: 3 },
      message: 'Queued user media object deletion failed',
    });
  });
});
