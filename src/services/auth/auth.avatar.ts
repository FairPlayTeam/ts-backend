import type { AuthService, DeleteAvatarInput, UploadAvatarInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { DELETE_AVATAR_SUCCESS_MESSAGE, UPLOAD_AVATAR_SUCCESS_MESSAGE } from './auth.messages.js';
import {
  createUserMediaObjectKey,
  deleteUserMediaAssetRecordIfCurrent,
  getUserMediaCacheControl,
  toUserMediaAssetResult,
  upsertStoredUserMediaAsset,
} from './auth.userMedia.js';

type AvatarService = Pick<AuthService, 'uploadAvatar' | 'deleteAvatar'>;

const AVATAR_KIND = 'avatar' as const;

const cleanupUploadedAvatarAfterFailure = async (
  deps: AuthDependencies,
  objectKey: string,
): Promise<void> => {
  await deps.objectStorage.deleteObject(objectKey).catch((err: unknown) => {
    deps.logger.warn({ err, objectKey }, 'Uploaded avatar cleanup failed after persistence error');
  });
};

export const createAvatarService = (deps: AuthDependencies): AvatarService => ({
  async uploadAvatar({ userId, file }: UploadAvatarInput) {
    const processedAvatar = await deps.userMediaProcessor.process({
      kind: AVATAR_KIND,
      file,
    });
    const objectKey = createUserMediaObjectKey(userId, AVATAR_KIND);

    await deps.objectStorage.putObject({
      objectKey,
      body: processedAvatar.buffer,
      contentType: processedAvatar.mimeType,
      cacheControl: getUserMediaCacheControl(),
    });

    const { asset, previousObjectKey } = await upsertStoredUserMediaAsset(deps, {
      userId,
      kind: AVATAR_KIND,
      objectKey,
      media: {
        mimeType: processedAvatar.mimeType,
        sizeBytes: processedAvatar.sizeBytes,
        width: processedAvatar.width,
        height: processedAvatar.height,
      },
    }).catch(async (err: unknown) => {
      await cleanupUploadedAvatarAfterFailure(deps, objectKey);
      throw err;
    });

    if (previousObjectKey && previousObjectKey !== objectKey) {
      await deps.objectStorage.deleteObject(previousObjectKey);
    }

    return {
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: await toUserMediaAssetResult(deps, asset),
    };
  },

  async deleteAvatar({ userId }: DeleteAvatarInput) {
    const asset = await deps.prisma.userMediaAsset.findUnique({
      where: {
        userId_kind: {
          userId,
          kind: AVATAR_KIND,
        },
      },
      select: {
        objectKey: true,
      },
    });

    if (asset) {
      await deps.objectStorage.deleteObject(asset.objectKey);

      await deleteUserMediaAssetRecordIfCurrent(deps, userId, AVATAR_KIND, asset.objectKey);
    }

    return {
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    };
  },
});
