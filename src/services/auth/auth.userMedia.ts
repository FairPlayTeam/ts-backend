import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { AuthDependencies } from './auth.dependencies.js';
import type { UserMediaAssetResult } from '../auth.types.js';
import type { ProcessedUserMedia, UserMediaKind } from '../userMedia/userMedia.types.js';

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

export const createUserMediaObjectKey = (userId: string, kind: UserMediaKind): string =>
  `users/${userId}/${kind}/${randomUUID()}.webp`;

export const getUserMediaCacheControl = (): string => USER_MEDIA_CACHE_CONTROL;

type UpsertStoredUserMediaAssetInput = {
  userId: string;
  kind: UserMediaKind;
  objectKey: string;
  media: Omit<ProcessedUserMedia, 'buffer'>;
};

const isTransactionConflictError = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

export const upsertStoredUserMediaAsset = async (
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

          return {
            asset,
            previousObjectKey: previousAsset?.objectKey ?? null,
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

export const deleteUserMediaAssetRecordIfCurrent = async (
  deps: AuthDependencies,
  userId: string,
  kind: UserMediaKind,
  objectKey: string,
): Promise<void> => {
  await deps.prisma.userMediaAsset.deleteMany({
    where: {
      userId,
      kind,
      objectKey,
    },
  });
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
  return asset ? deps.objectStorage.getSignedUrl(asset.objectKey) : null;
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

export const deleteStoredUserMediaObjects = async (
  deps: AuthDependencies,
  userId: string,
): Promise<void> => {
  const assets = await deps.prisma.userMediaAsset.findMany({
    where: { userId },
    select: {
      objectKey: true,
    },
  });

  const objectKeys = assets.map((asset) => asset.objectKey);

  if (objectKeys.length === 0) {
    return;
  }

  await deps.objectStorage.deleteObjects(objectKeys);
};
