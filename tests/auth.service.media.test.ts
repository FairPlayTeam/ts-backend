import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createAuthService } from '../src/services/auth.service.js';
import {
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { AuthenticatedUserNotFoundError } from '../src/services/auth.errors.js';
import {
  avatarObjectKeyPattern,
  bannerObjectKeyPattern,
  createTestDeps,
  createUserMediaAssetDeletionTransaction,
  fixedNow,
} from './support/authService.js';

describe('auth service media', () => {
  test('reserves an exact external target before uploading and persists the normalized avatar', async () => {
    const events: string[] = [];
    const { deps, calls } = createTestDeps({
      objectStorage: {
        bucket: 'fairplay-user-media',
        putObject: async (input: unknown) => {
          events.push('put');
          calls.putObject = input;
        },
        getSignedUrl: async (objectKey: string, bucket?: string) => {
          calls.signedUrlObjectKey = objectKey;
          return `http://localhost:9000/${bucket}/${objectKey}`;
        },
      },
    });
    const originalTransaction = deps.prisma.$transaction.bind(deps.prisma);
    deps.prisma.$transaction = ((...args: Parameters<typeof originalTransaction>) => {
      events.push('transaction');
      return originalTransaction(...args);
    }) as typeof deps.prisma.$transaction;
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });
    const objectKey = calls.signedUrlObjectKey as string;

    expect(objectKey).toMatch(avatarObjectKeyPattern);
    expect(events.slice(0, 2)).toEqual(['transaction', 'put']);
    expect(calls.externalResourceTargetCreate).toEqual({
      data: {
        userId: 'user-id',
        videoId: null,
        bucket: 'fairplay-user-media',
        selector: objectKey,
        selectorKind: 'exact',
        role: 'user_media',
        generation: expect.any(String),
        expectedSizeBytes: 6n,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
        nextAttemptAt: new Date('2026-01-01T01:00:00.000Z'),
      },
      select: { id: true },
    });
    expect(calls.putObject).toEqual({
      objectKey,
      body: Buffer.from('avatar'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    expect(calls.userMediaAssetUpsert).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      update: {
        objectKey,
        bucket: 'fairplay-user-media',
        externalResourceTargetId: 'target-id',
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      create: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
        bucket: 'fairplay-user-media',
        externalResourceTargetId: 'target-id',
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      select: {
        objectKey: true,
        bucket: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        updatedAt: true,
      },
    });
    expect(result).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: `http://localhost:9000/fairplay-user-media/${objectKey}`,
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
        updatedAt: fixedNow,
      },
    });
  });

  test('schedules the previous target for durable cleanup when replacing media', async () => {
    const reconciledTargets: string[] = [];
    const { deps, calls } = createTestDeps({
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          reconciledTargets.push(targetId);
          return 'skipped';
        },
      },
    });
    calls.previousUserMediaTargetId = 'previous-target';
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: { buffer: Buffer.from('raw-avatar'), size: 10 },
      }),
    ).resolves.toMatchObject({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
    });

    expect(calls.externalResourceTargetUpdates).toEqual([
      expect.objectContaining({
        where: { id: 'previous-target' },
        data: expect.objectContaining({
          goal: 'absent',
          state: 'quiescing',
          quiescenceNotBefore: new Date('2026-01-01T01:00:00.000Z'),
        }),
      }),
    ]);
    expect(reconciledTargets).toEqual(['previous-target']);
  });

  test('leaves a failed PUT reserved for canonical cleanup', async () => {
    const putError = new Error('ambiguous PUT failure');
    const targetUpdates: unknown[] = [];
    const reconciledTargets: string[] = [];
    let transactionNumber = 0;
    const { deps } = createTestDeps({
      objectStorage: {
        bucket: 'fairplay-user-media',
        putObject: async () => {
          throw putError;
        },
        getSignedUrl: async () => 'unused',
      },
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          reconciledTargets.push(targetId);
          return 'skipped';
        },
      },
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
          transactionNumber += 1;

          return callback(
            transactionNumber === 1
              ? {
                  user: { findUnique: async () => ({ id: 'user-id' }) },
                  externalResourceTarget: {
                    create: async () => ({ id: 'new-target' }),
                  },
                }
              : {
                  externalResourceTarget: {
                    findUnique: async () => ({
                      state: 'writing',
                      quiescenceNotBefore: null,
                      nextAttemptAt: new Date('2026-01-01T01:00:00.000Z'),
                    }),
                    update: async (args: unknown) => {
                      targetUpdates.push(args);
                      return { id: 'new-target' };
                    },
                  },
                },
          );
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: { buffer: Buffer.from('raw-avatar'), size: 10 },
      }),
    ).rejects.toBe(putError);

    expect(targetUpdates).toEqual([
      expect.objectContaining({
        where: { id: 'new-target' },
        data: expect.objectContaining({
          goal: 'absent',
          state: 'quiescing',
          quiescenceNotBefore: new Date('2026-01-01T01:00:00.000Z'),
        }),
      }),
    ]);
    expect(reconciledTargets).toEqual(['new-target']);
  });

  test('retries media persistence on a serializable transaction conflict', async () => {
    const { deps } = createTestDeps();
    const originalTransaction = deps.prisma.$transaction.bind(deps.prisma);
    let calls = 0;
    deps.prisma.$transaction = ((...args: Parameters<typeof originalTransaction>) => {
      calls += 1;

      if (calls === 2) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError('serialization failure', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        );
      }

      return originalTransaction(...args);
    }) as typeof deps.prisma.$transaction;
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: { buffer: Buffer.from('raw-avatar'), size: 10 },
      }),
    ).resolves.toMatchObject({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
    });
    expect(calls).toBe(3);
  });

  test('does not delete a possibly committed media target after an ambiguous SQL error', async () => {
    const persistenceError = new Error('ambiguous persistence result');
    let transactionNumber = 0;
    const reconciledTargets: string[] = [];
    const { deps } = createTestDeps({
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          reconciledTargets.push(targetId);
          return 'skipped';
        },
      },
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
          transactionNumber += 1;

          if (transactionNumber === 1) {
            return callback({
              user: { findUnique: async () => ({ id: 'user-id' }) },
              externalResourceTarget: {
                create: async () => ({ id: 'new-target' }),
              },
            });
          }

          throw persistenceError;
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: { buffer: Buffer.from('raw-avatar'), size: 10 },
      }),
    ).rejects.toBe(persistenceError);
    expect(transactionNumber).toBe(2);
    expect(reconciledTargets).toEqual([]);
  });

  test('maps a user foreign-key race and keeps the uploaded object reconcilable', async () => {
    const foreignKeyError = new Prisma.PrismaClientKnownRequestError('foreign key', {
      code: 'P2003',
      clientVersion: 'test',
      meta: { field_name: 'user_id' },
    });
    let transactionNumber = 0;
    const reconciledTargets: string[] = [];
    const { deps } = createTestDeps({
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          reconciledTargets.push(targetId);
          return 'skipped';
        },
      },
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
          transactionNumber += 1;

          if (transactionNumber === 1) {
            return callback({
              user: { findUnique: async () => ({ id: 'user-id' }) },
              externalResourceTarget: {
                create: async () => ({ id: 'new-target' }),
              },
            });
          }

          if (transactionNumber === 2) {
            throw foreignKeyError;
          }

          return callback({
            externalResourceTarget: {
              findUnique: async () => ({
                state: 'writing',
                quiescenceNotBefore: null,
                nextAttemptAt: new Date('2026-01-01T01:00:00.000Z'),
              }),
              update: async () => ({ id: 'new-target' }),
            },
          });
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: { buffer: Buffer.from('raw-avatar'), size: 10 },
      }),
    ).rejects.toBeInstanceOf(AuthenticatedUserNotFoundError);
    expect(reconciledTargets).toEqual(['new-target']);
  });

  test('uploads a normalized banner through the same durable flow', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.uploadBanner({
      userId: 'user-id',
      file: { buffer: Buffer.from('raw-banner'), size: 10 },
    });
    const objectKey = calls.signedUrlObjectKey as string;

    expect(objectKey).toMatch(bannerObjectKeyPattern);
    expect(result).toEqual({
      message: UPLOAD_BANNER_SUCCESS_MESSAGE,
      banner: {
        url: `http://localhost:9000/fairplay-user-media/${objectKey}`,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
        updatedAt: fixedNow,
      },
    });
  });

  test('removes the media row before scheduling exact cleanup', async () => {
    const events: string[] = [];
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(
            createUserMediaAssetDeletionTransaction({
              calls,
              objectKey: 'users/user-id/avatar/old.webp',
              deleteMany: async (args) => {
                events.push('delete-row');
                calls.userMediaAssetDeleteMany = args;
                return { count: 1 };
              },
            }),
          ),
      },
      externalResources: {
        reconcileDue: async () => ({
          claimed: 0,
          confirmed: 0,
          redirectedAbsent: 0,
          failed: 0,
        }),
        reconcileTarget: async ({ targetId }: { targetId: string }) => {
          events.push(`reconcile-${targetId}`);
          return 'skipped';
        },
      },
    });
    const service = createAuthService(deps);

    await expect(service.deleteAvatar({ userId: 'user-id' })).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(events).toEqual(['delete-row', 'reconcile-target-id']);
    expect(calls.externalResourceTargetUpdate).toEqual(
      expect.objectContaining({
        where: { id: 'target-id' },
        data: expect.objectContaining({
          goal: 'absent',
          state: 'quiescing',
          quiescenceNotBefore: new Date('2026-01-01T01:00:00.000Z'),
        }),
      }),
    );
  });

  test('does not schedule cleanup when row deletion loses a race', async () => {
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(
            createUserMediaAssetDeletionTransaction({
              calls,
              objectKey: 'users/user-id/avatar/old.webp',
              deleteMany: async () => ({ count: 0 }),
            }),
          ),
      },
    });
    const service = createAuthService(deps);

    await expect(service.deleteAvatar({ userId: 'user-id' })).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });
    expect(calls.externalResourceTargetUpdate).toBeUndefined();
    expect(calls.reconcileTarget).toBeUndefined();
  });

  test('keeps deletion idempotent when no banner exists', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(service.deleteBanner({ userId: 'user-id' })).resolves.toEqual({
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    });
    expect(calls.reconcileTarget).toBeUndefined();
  });
});
