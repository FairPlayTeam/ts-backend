import type { AuthService, DeleteAvatarInput, UploadAvatarInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { DELETE_AVATAR_SUCCESS_MESSAGE, UPLOAD_AVATAR_SUCCESS_MESSAGE } from './auth.messages.js';
import {
  deleteUserMediaAsset,
  toUserMediaAssetResult,
  uploadUserMediaAsset,
} from './auth.userMedia.js';

type AvatarService = Pick<AuthService, 'uploadAvatar' | 'deleteAvatar'>;

const AVATAR_KIND = 'avatar' as const;

export const createAvatarService = (deps: AuthDependencies): AvatarService => ({
  async uploadAvatar({ userId, file }: UploadAvatarInput) {
    const avatar = await uploadUserMediaAsset(deps, {
      userId,
      kind: AVATAR_KIND,
      file,
    });

    return {
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: await toUserMediaAssetResult(deps, avatar),
    };
  },

  async deleteAvatar({ userId }: DeleteAvatarInput) {
    await deleteUserMediaAsset(deps, userId, AVATAR_KIND);

    return {
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    };
  },
});
