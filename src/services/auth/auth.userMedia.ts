import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
  ExternalResourceNotDesiredError,
  requestExternalResourceAbsence,
  type ExternalResourceReconciliationHandler,
} from '../externalResources.js';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { isPrismaForeignKeyConstraintError } from './auth.prismaErrors.js';
import type { ProcessedUserMedia, UserMediaKind } from '../userMedia/userMedia.types.js';
import { profileAvatarPath, profileBannerPath } from '../assets/assetLinks.js';
import type { UserMediaAssetResult } from './types/profileMedia.types.js';
import { AuthenticatedUserNotFoundError } from '../auth.errors.js';

const USER_MEDIA_CACHE_CONTROL = 'private, max-age=900';

type StoredUserMediaAsset = {
  objectKey: string;
  bucket: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: Date;
};

type UploadedUserMediaAsset = StoredUserMediaAsset & {
  username: string;
};

type UserMediaFileInput = {
  buffer: Buffer;
  size: number;
};

const createUserMediaObjectKey = (
  userId: string,
  kind: UserMediaKind,
  generation: string,
): string => `users/${userId}/${kind}/${generation}.webp`;

type UpsertStoredUserMediaAssetInput = {
  userId: string;
  kind: UserMediaKind;
  objectKey: string;
  targetId: string;
  media: Omit<ProcessedUserMedia, 'buffer'>;
};

const scheduleUserMediaTargetAbsence = async (
  deps: AuthDependencies,
  targetId: string,
): Promise<void> => {
  const requestedAt = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    await requestExternalResourceAbsence(tx, targetId, requestedAt);
  });
};

const tryImmediateUserMediaReconciliation = async (
  deps: AuthDependencies,
  targetId: string,
  warningMessage: string,
): Promise<void> => {
  await deps.externalResources
    .reconcileTarget({
      targetId,
      roles: ['user_media'],
      handlers: {
        user_media: createUserMediaReconciliationHandler(deps),
      },
    })
    .catch((err: unknown) => {
      deps.logger.warn({ err, targetId }, warningMessage);
    });
};

const upsertStoredUserMediaAsset = async (
  deps: AuthDependencies,
  { userId, kind, objectKey, targetId, media }: UpsertStoredUserMediaAssetInput,
): Promise<{
  asset: StoredUserMediaAsset;
  previousTargetId: string | null;
}> => {
  const now = deps.clock.now();

  return runSerializableTransaction(deps.prisma, async (tx) => {
    const previousAsset = await tx.userMediaAsset.findUnique({
      where: {
        userId_kind: {
          userId,
          kind,
        },
      },
      select: {
        externalResourceTargetId: true,
      },
    });
    const targetConfirmed = await tx.externalResourceTarget.updateMany({
      where: {
        id: targetId,
        userId,
        videoId: null,
        role: 'user_media',
        selectorKind: 'exact',
        selector: objectKey,
        goal: 'present',
        state: 'writing',
      },
      data: {
        state: 'confirmed_present',
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
      },
    });

    if (targetConfirmed.count === 0) {
      throw new Error('User media reservation is no longer writable');
    }

    const asset = await tx.userMediaAsset.upsert({
      where: {
        userId_kind: {
          userId,
          kind,
        },
      },
      update: {
        objectKey,
        bucket: deps.objectStorage.bucket,
        externalResourceTargetId: targetId,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        width: media.width,
        height: media.height,
      },
      create: {
        userId,
        kind,
        objectKey,
        bucket: deps.objectStorage.bucket,
        externalResourceTargetId: targetId,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        width: media.width,
        height: media.height,
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
    const previousTargetId = previousAsset?.externalResourceTargetId ?? null;

    if (previousTargetId && previousTargetId !== targetId) {
      await requestExternalResourceAbsence(tx, previousTargetId, now);
    }

    return {
      asset,
      previousTargetId: previousTargetId && previousTargetId !== targetId ? previousTargetId : null,
    };
  });
};

type UploadUserMediaAssetInput = {
  userId: string;
  kind: UserMediaKind;
  file: UserMediaFileInput;
};

export const createUserMediaReconciliationHandler = (
  deps: AuthDependencies,
): ExternalResourceReconciliationHandler => ({
  async preparePresent(target) {
    const asset = await deps.prisma.userMediaAsset.findFirst({
      where: {
        userId: target.userId,
        bucket: target.bucket,
        objectKey: target.selector,
        externalResourceTargetId: target.id,
      },
      select: {
        id: true,
      },
    });

    if (!asset) {
      throw new ExternalResourceNotDesiredError('User media reservation has no persisted asset');
    }
  },
});

export const uploadUserMediaAsset = async (
  deps: AuthDependencies,
  { userId, kind, file }: UploadUserMediaAssetInput,
): Promise<UploadedUserMediaAsset> => {
  const processedMedia = await deps.userMediaProcessor.process({
    kind,
    file,
  });
  const generation = randomUUID();
  const objectKey = createUserMediaObjectKey(userId, kind, generation);
  const reservedAt = deps.clock.now();
  const target = await runSerializableTransaction(deps.prisma, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });

    if (!user) {
      throw new AuthenticatedUserNotFoundError();
    }

    const reservedTarget = await tx.externalResourceTarget.create({
      data: {
        userId,
        videoId: null,
        bucket: deps.objectStorage.bucket,
        selector: objectKey,
        selectorKind: 'exact',
        role: 'user_media',
        generation,
        expectedSizeBytes: BigInt(processedMedia.sizeBytes),
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
        nextAttemptAt: new Date(reservedAt.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS),
      },
      select: {
        id: true,
      },
    });

    return {
      ...reservedTarget,
      username: user.username,
    };
  });

  try {
    await deps.objectStorage.putObject({
      objectKey,
      body: processedMedia.buffer,
      contentType: processedMedia.mimeType,
      cacheControl: USER_MEDIA_CACHE_CONTROL,
    });
  } catch (err) {
    await scheduleUserMediaTargetAbsence(deps, target.id).catch((cleanupError: unknown) => {
      deps.logger.warn(
        { err: cleanupError, kind, objectKey, targetId: target.id },
        'Failed to schedule user media cleanup after PUT failure',
      );
    });
    await tryImmediateUserMediaReconciliation(
      deps,
      target.id,
      'Immediate user media reconciliation failed after PUT failure',
    );
    throw err;
  }

  const { asset, previousTargetId } = await upsertStoredUserMediaAsset(deps, {
    userId,
    kind,
    objectKey,
    targetId: target.id,
    media: {
      mimeType: processedMedia.mimeType,
      sizeBytes: processedMedia.sizeBytes,
      width: processedMedia.width,
      height: processedMedia.height,
    },
  }).catch(async (err: unknown) => {
    if (isPrismaForeignKeyConstraintError(err)) {
      await scheduleUserMediaTargetAbsence(deps, target.id).catch((cleanupError: unknown) => {
        deps.logger.warn(
          { err: cleanupError, kind, objectKey, targetId: target.id },
          'Failed to schedule uploaded user media after user deletion race',
        );
      });
      await tryImmediateUserMediaReconciliation(
        deps,
        target.id,
        'Immediate uploaded user media reconciliation failed after user deletion race',
      );
      throw new AuthenticatedUserNotFoundError(err);
    }

    throw err;
  });

  if (previousTargetId) {
    await tryImmediateUserMediaReconciliation(
      deps,
      previousTargetId,
      'Immediate previous user media reconciliation failed after replacement',
    );
  }

  return {
    ...asset,
    username: target.username,
  };
};

export const deleteUserMediaAsset = async (
  deps: AuthDependencies,
  userId: string,
  kind: UserMediaKind,
): Promise<void> => {
  const requestedAt = deps.clock.now();
  const targetId = await runSerializableTransaction(deps.prisma, async (tx) => {
    const asset = await tx.userMediaAsset.findUnique({
      where: {
        userId_kind: {
          userId,
          kind,
        },
      },
      select: {
        id: true,
        externalResourceTargetId: true,
      },
    });

    if (!asset) {
      return null;
    }

    const deleted = await tx.userMediaAsset.deleteMany({
      where: {
        id: asset.id,
        userId,
      },
    });

    if (deleted.count === 0) {
      return null;
    }

    await requestExternalResourceAbsence(tx, asset.externalResourceTargetId, requestedAt);

    return asset.externalResourceTargetId;
  });

  if (targetId) {
    await tryImmediateUserMediaReconciliation(
      deps,
      targetId,
      'Immediate user media reconciliation failed after record deletion',
    );
  }
};

export const toUserMediaAssetResult = (
  asset: UploadedUserMediaAsset,
  kind: UserMediaKind,
): UserMediaAssetResult => ({
  url: kind === 'avatar' ? profileAvatarPath(asset.username) : profileBannerPath(asset.username),
  mimeType: asset.mimeType,
  sizeBytes: asset.sizeBytes,
  width: asset.width,
  height: asset.height,
  updatedAt: asset.updatedAt,
});
