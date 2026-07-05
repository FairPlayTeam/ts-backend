import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuthDependencies } from './auth.dependencies.js';
import { isPrismaForeignKeyConstraintError } from './auth.prismaErrors.js';
import type { ProcessedUserMedia, UserMediaKind } from '../userMedia/userMedia.types.js';
import { toStoredUserMediaAssetUrl } from '../userMedia/userMedia.profileAssets.js';
import type { UserMediaAssetResult } from './types/profileMedia.types.js';
import { AuthenticatedUserNotFoundError } from '../auth.errors.js';

const USER_MEDIA_CACHE_CONTROL = 'private, max-age=900';
const USER_MEDIA_TRANSACTION_MAX_ATTEMPTS = 3;

type StoredUserMediaAsset = {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: Date;
};

type UserMediaFileInput = {
  buffer: Buffer;
  size: number;
};

type UserMediaDeletionJobStore = Pick<AuthDependencies['prisma'], 'userMediaDeletionJob'>;

const createUserMediaObjectKey = (userId: string, kind: UserMediaKind): string =>
  `users/${userId}/${kind}/${randomUUID()}.webp`;

const uniqueObjectKeys = (objectKeys: readonly string[]): string[] => [...new Set(objectKeys)];

export const queueUserMediaObjectDeletions = async (
  store: UserMediaDeletionJobStore,
  objectKeys: readonly string[],
): Promise<number> => {
  const uniqueKeys = uniqueObjectKeys(objectKeys);

  if (uniqueKeys.length === 0) {
    return 0;
  }

  const result = await store.userMediaDeletionJob.createMany({
    data: uniqueKeys.map((objectKey) => ({ objectKey })),
    skipDuplicates: true,
  });

  return result.count;
};

type UpsertStoredUserMediaAssetInput = {
  userId: string;
  kind: UserMediaKind;
  objectKey: string;
  media: Omit<ProcessedUserMedia, 'buffer'>;
};

const isTransactionConflictError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

const upsertStoredUserMediaAsset = async (
  deps: AuthDependencies,
  { userId, kind, objectKey, media }: UpsertStoredUserMediaAssetInput,
): Promise<{ asset: StoredUserMediaAsset; previousObjectKey: string | null }> => {
  for (let attempt = 1; attempt <= USER_MEDIA_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await deps.prisma.$transaction(
        async (tx) => {
          const previousAsset = await tx.userMediaAsset.findUnique({
            where: {
              userId_kind: {
                userId,
                kind,
              },
            },
            select: {
              objectKey: true,
            },
          });

          const asset = await tx.userMediaAsset.upsert({
            where: {
              userId_kind: {
                userId,
                kind,
              },
            },
            update: {
              objectKey,
              mimeType: media.mimeType,
              sizeBytes: media.sizeBytes,
              width: media.width,
              height: media.height,
            },
            create: {
              userId,
              kind,
              objectKey,
              mimeType: media.mimeType,
              sizeBytes: media.sizeBytes,
              width: media.width,
              height: media.height,
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

          const previousObjectKey = previousAsset?.objectKey ?? null;

          if (previousObjectKey && previousObjectKey !== objectKey) {
            await queueUserMediaObjectDeletions(tx, [previousObjectKey]);
          }

          return {
            asset,
            previousObjectKey,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (err) {
      if (!isTransactionConflictError(err) || attempt === USER_MEDIA_TRANSACTION_MAX_ATTEMPTS) {
        throw err;
      }
    }
  }

  throw new Error('User media transaction retry loop exhausted unexpectedly');
};

type UploadUserMediaAssetInput = {
  userId: string;
  kind: UserMediaKind;
  file: UserMediaFileInput;
};

const cleanupUploadedUserMediaAfterFailure = async (
  deps: AuthDependencies,
  kind: UserMediaKind,
  objectKey: string,
): Promise<void> => {
  await deps.objectStorage.deleteObject(objectKey).catch((err: unknown) => {
    deps.logger.warn(
      { err, kind, objectKey },
      'Uploaded user media cleanup failed after persistence error',
    );
  });
};

const cleanupUserMediaObjectAfterStateChange = async (
  deps: AuthDependencies,
  userId: string,
  objectKey: string,
  warningMessage: string,
): Promise<boolean> => {
  try {
    await deps.objectStorage.deleteObject(objectKey);
    await deps.prisma.userMediaDeletionJob.deleteMany({
      where: {
        objectKey,
      },
    });

    return true;
  } catch (err) {
    deps.logger.warn({ err, userId, objectKey }, warningMessage);

    return false;
  }
};

export const uploadUserMediaAsset = async (
  deps: AuthDependencies,
  { userId, kind, file }: UploadUserMediaAssetInput,
): Promise<StoredUserMediaAsset> => {
  const processedMedia = await deps.userMediaProcessor.process({
    kind,
    file,
  });
  const objectKey = createUserMediaObjectKey(userId, kind);

  await deps.objectStorage.putObject({
    objectKey,
    body: processedMedia.buffer,
    contentType: processedMedia.mimeType,
    cacheControl: USER_MEDIA_CACHE_CONTROL,
  });

  const { asset, previousObjectKey } = await upsertStoredUserMediaAsset(deps, {
    userId,
    kind,
    objectKey,
    media: {
      mimeType: processedMedia.mimeType,
      sizeBytes: processedMedia.sizeBytes,
      width: processedMedia.width,
      height: processedMedia.height,
    },
  }).catch(async (err: unknown) => {
    await cleanupUploadedUserMediaAfterFailure(deps, kind, objectKey);

    if (isPrismaForeignKeyConstraintError(err)) {
      throw new AuthenticatedUserNotFoundError(err);
    }

    throw err;
  });

  if (previousObjectKey && previousObjectKey !== objectKey) {
    await cleanupUserMediaObjectAfterStateChange(
      deps,
      userId,
      previousObjectKey,
      'Previous user media object cleanup failed after replacement; cleanup remains queued',
    );
  }

  return asset;
};

export const deleteUserMediaAsset = async (
  deps: AuthDependencies,
  userId: string,
  kind: UserMediaKind,
): Promise<void> => {
  const deletedObjectKey = await deps.prisma.$transaction(async (tx) => {
    const asset = await tx.userMediaAsset.findUnique({
      where: {
        userId_kind: {
          userId,
          kind,
        },
      },
      select: {
        objectKey: true,
      },
    });

    if (!asset) {
      return null;
    }

    const deletedRecord = await tx.userMediaAsset.deleteMany({
      where: {
        userId,
        kind,
        objectKey: asset.objectKey,
      },
    });

    if (deletedRecord.count === 0) {
      return null;
    }

    await queueUserMediaObjectDeletions(tx, [asset.objectKey]);

    return asset.objectKey;
  });

  if (!deletedObjectKey) {
    return;
  }

  await cleanupUserMediaObjectAfterStateChange(
    deps,
    userId,
    deletedObjectKey,
    'User media object cleanup failed after record deletion; cleanup remains queued',
  );
};

export function toUserMediaAssetUrl(
  deps: AuthDependencies,
  asset: { objectKey: string },
): Promise<string>;
export function toUserMediaAssetUrl(
  deps: AuthDependencies,
  asset: { objectKey: string } | null | undefined,
): Promise<string | null>;
export async function toUserMediaAssetUrl(
  deps: AuthDependencies,
  asset: { objectKey: string } | null | undefined,
): Promise<string | null> {
  return toStoredUserMediaAssetUrl(deps.objectStorage, asset);
}

export const toUserMediaAssetResult = async (
  deps: AuthDependencies,
  asset: StoredUserMediaAsset,
): Promise<UserMediaAssetResult> => ({
  url: await toUserMediaAssetUrl(deps, asset),
  mimeType: asset.mimeType,
  sizeBytes: asset.sizeBytes,
  width: asset.width,
  height: asset.height,
  updatedAt: asset.updatedAt,
});

export const deleteStoredUserMediaObjectsAfterStateChange = async (
  deps: AuthDependencies,
  userId: string,
  objectKeys: readonly string[],
): Promise<{ deletedCount: number; queuedCount: number }> => {
  const uniqueKeys = uniqueObjectKeys(objectKeys);

  if (uniqueKeys.length === 0) {
    return { deletedCount: 0, queuedCount: 0 };
  }

  const results = await Promise.all(
    uniqueKeys.map((objectKey) =>
      cleanupUserMediaObjectAfterStateChange(
        deps,
        userId,
        objectKey,
        'Stored user media object cleanup failed after account deletion; cleanup remains queued',
      ),
    ),
  );
  const deletedCount = results.filter(Boolean).length;

  return {
    deletedCount,
    queuedCount: uniqueKeys.length - deletedCount,
  };
};
