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
  createUserMediaDeletionJobMock,
  fixedNow,
} from './support/authService.js';
import type { AuthDeps } from './support/authService.js';

describe('auth service media', () => {
  test('uploads and stores a normalized avatar for a user', async () => {
    const { deps, calls } = createTestDeps();
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

    expect(calls.processedMedia).toEqual({
      kind: 'avatar',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });
    expect(calls.putObject).toEqual({
      objectKey,
      body: Buffer.from('avatar'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
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
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      create: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      },
      select: {
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        updatedAt: true,
      },
    });
  });

  test('deletes the previous avatar object after replacing it', async () => {
    const previousObjectKey = 'users/user-id/avatar/previous-avatar.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findUnique: async (args: unknown) => {
                calls.userMediaAssetFindUnique = args;

                return {
                  objectKey: previousObjectKey,
                };
              },
              upsert: async (args: unknown) => {
                calls.userMediaAssetUpsert = args;
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          }),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });

    expect(result.message).toBe(UPLOAD_AVATAR_SUCCESS_MESSAGE);
    expect(calls.signedUrlObjectKey).toMatch(avatarObjectKeyPattern);
    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey: previousObjectKey },
    });
  });

  test('keeps avatar upload successful when previous object cleanup fails', async () => {
    const previousObjectKey = 'users/user-id/avatar/previous-avatar.webp';
    const cleanupError = new Error('object storage unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            userMediaAsset: {
              findUnique: async () => ({
                objectKey: previousObjectKey,
              }),
              upsert: async (args: unknown) => {
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
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
          calls.deleteObject = objectKey;
          throw cleanupError;
        },
        getSignedUrl: async (objectKey: string) => {
          calls.signedUrlObjectKey = objectKey;

          return `http://localhost:9000/fairplay-user-media/${objectKey}`;
        },
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: {
          buffer: Buffer.from('raw-avatar'),
          size: 10,
        },
      }),
    ).resolves.toMatchObject({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
    });

    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey: previousObjectKey },
      message:
        'Previous user media object cleanup failed after replacement; cleanup remains queued',
    });
  });

  test('retries avatar persistence on serializable transaction conflicts', async () => {
    const conflictError = new Prisma.PrismaClientKnownRequestError('Transaction conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const previousObjectKey = 'users/user-id/avatar/previous-after-conflict.webp';
    const transactionOptions: unknown[] = [];
    let transactionAttempts = 0;
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
          options?: unknown,
        ) => {
          transactionAttempts += 1;
          transactionOptions.push(options);

          if (transactionAttempts === 1) {
            throw conflictError;
          }

          return callback({
            userMediaAsset: {
              findUnique: async (args: unknown) => {
                calls.userMediaAssetFindUnique = args;

                return {
                  objectKey: previousObjectKey,
                };
              },
              upsert: async (args: unknown) => {
                calls.userMediaAssetUpsert = args;
                const upsertArgs = args as {
                  update: {
                    objectKey: string;
                    mimeType: string;
                    sizeBytes: number;
                    width: number;
                    height: number;
                  };
                };

                return {
                  ...upsertArgs.update,
                  updatedAt: fixedNow,
                };
              },
            },
            userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
          });
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    const result = await service.uploadAvatar({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-avatar'),
        size: 10,
      },
    });

    expect(result.message).toBe(UPLOAD_AVATAR_SUCCESS_MESSAGE);
    expect(transactionAttempts).toBe(2);
    expect(transactionOptions).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
    expect(calls.deleteObject).toBe(previousObjectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey: previousObjectKey }],
      skipDuplicates: true,
    });
    expect(calls.signedUrlObjectKey).toMatch(avatarObjectKeyPattern);
  });

  test('cleans up the uploaded avatar object when persistence fails', async () => {
    const persistenceError = new Error('database unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async () => {
          throw persistenceError;
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: {
          buffer: Buffer.from('raw-avatar'),
          size: 10,
        },
      }),
    ).rejects.toBe(persistenceError);

    const uploadedObjectKey = (calls.putObject as { objectKey: string }).objectKey;
    expect(uploadedObjectKey).toMatch(avatarObjectKeyPattern);
    expect(calls.deleteObject).toBe(uploadedObjectKey);
  });

  test('cleans up the uploaded avatar object when the authenticated user disappeared', async () => {
    const missingUserError = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed',
      {
        code: 'P2003',
        clientVersion: 'test',
      },
    );
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async () => {
          throw missingUserError;
        },
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.uploadAvatar({
        userId: 'user-id',
        file: {
          buffer: Buffer.from('raw-avatar'),
          size: 10,
        },
      }),
    ).rejects.toBeInstanceOf(AuthenticatedUserNotFoundError);

    const uploadedObjectKey = (calls.putObject as { objectKey: string }).objectKey;
    expect(uploadedObjectKey).toMatch(avatarObjectKeyPattern);
    expect(calls.deleteObject).toBe(uploadedObjectKey);
  });

  test('uploads and stores a normalized banner for a user', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    const result = await service.uploadBanner({
      userId: 'user-id',
      file: {
        buffer: Buffer.from('raw-banner'),
        size: 10,
      },
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

    expect(calls.processedMedia).toEqual({
      kind: 'banner',
      file: {
        buffer: Buffer.from('raw-banner'),
        size: 10,
      },
    });
    expect(calls.putObject).toEqual({
      objectKey,
      body: Buffer.from('banner'),
      contentType: 'image/webp',
      cacheControl: 'private, max-age=900',
    });
    expect(calls.userMediaAssetUpsert).toMatchObject({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'banner',
        },
      },
      update: {
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
      },
      create: {
        userId: 'user-id',
        kind: 'banner',
        objectKey,
        mimeType: 'image/webp',
        sizeBytes: 7,
        width: 1500,
        height: 500,
      },
    });
  });

  test('deletes an existing avatar for a user', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey },
    });
  });

  test('keeps avatar deletion successful when object cleanup fails', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const cleanupError = new Error('object storage unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
      objectStorage: {
        putObject: async (input: unknown) => {
          calls.putObject = input;
        },
        deleteObject: async (deletedObjectKey: string) => {
          calls.deleteObject = deletedObjectKey;
          throw cleanupError;
        },
        getSignedUrl: async (signedObjectKey: string) =>
          `http://localhost:9000/fairplay-user-media/${signedObjectKey}`,
      },
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toBeUndefined();
    expect(calls.warning).toEqual({
      data: { err: cleanupError, userId: 'user-id', objectKey },
      message: 'User media object cleanup failed after record deletion; cleanup remains queued',
    });
  });

  test('does not delete avatar objects when record deletion fails', async () => {
    const objectKey = 'users/user-id/avatar/current-avatar.webp';
    const deletionError = new Error('database unavailable');
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(
            createUserMediaAssetDeletionTransaction({
              calls,
              objectKey,
              deleteMany: async () => {
                throw deletionError;
              },
            }),
          ),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).rejects.toBe(deletionError);

    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'avatar',
        objectKey,
      },
    });
    expect(calls.deleteObject).toBeUndefined();
    expect(calls.userMediaDeletionJobCreateMany).toBeUndefined();
  });

  test('keeps avatar deletion idempotent when no avatar exists', async () => {
    const { deps, calls } = createTestDeps();
    const service = createAuthService(deps);

    await expect(
      service.deleteAvatar({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'avatar',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBeUndefined();
    expect(calls.userMediaAssetDeleteMany).toBeUndefined();
  });

  test('deletes an existing banner for a user', async () => {
    const objectKey = 'users/user-id/banner/current-banner.webp';
    const { deps, calls } = createTestDeps({
      prisma: {
        $transaction: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback(createUserMediaAssetDeletionTransaction({ calls, objectKey })),
      } as unknown as AuthDeps['prisma'],
    });
    const service = createAuthService(deps);

    await expect(
      service.deleteBanner({
        userId: 'user-id',
      }),
    ).resolves.toEqual({
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    });

    expect(calls.userMediaAssetFindUnique).toEqual({
      where: {
        userId_kind: {
          userId: 'user-id',
          kind: 'banner',
        },
      },
      select: {
        objectKey: true,
      },
    });
    expect(calls.deleteObject).toBe(objectKey);
    expect(calls.userMediaAssetDeleteMany).toEqual({
      where: {
        userId: 'user-id',
        kind: 'banner',
        objectKey,
      },
    });
    expect(calls.userMediaDeletionJobCreateMany).toEqual({
      data: [{ objectKey }],
      skipDuplicates: true,
    });
    expect(calls.userMediaDeletionJobDeleteMany).toEqual({
      where: { objectKey },
    });
  });
});
