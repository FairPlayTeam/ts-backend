import type {
  AuthProfileMediaPort,
  DeleteAvatarInput,
  DeleteBannerInput,
  UploadAvatarInput,
  UploadBannerInput,
  UploadUserMediaInput,
  UserMediaAssetResult,
} from './types/profileMedia.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
} from './auth.messages.js';
import {
  deleteUserMediaAsset,
  toUserMediaAssetResult,
  uploadUserMediaAsset,
} from './auth.userMedia.js';
import type { UserMediaKind } from '../userMedia/userMedia.types.js';

type ProfileMediaService = Pick<
  AuthProfileMediaPort,
  'uploadAvatar' | 'deleteAvatar' | 'uploadBanner' | 'deleteBanner'
>;

type UploadProfileMediaInput = {
  userId: string;
  kind: UserMediaKind;
  file: UploadUserMediaInput['file'];
};

const uploadProfileMedia = async (
  deps: AuthDependencies,
  { userId, kind, file }: UploadProfileMediaInput,
): Promise<UserMediaAssetResult> => {
  const asset = await uploadUserMediaAsset(deps, {
    userId,
    kind,
    file,
  });

  return toUserMediaAssetResult(deps, asset);
};

const deleteProfileMedia = async (
  deps: AuthDependencies,
  userId: string,
  kind: UserMediaKind,
): Promise<void> => {
  await deleteUserMediaAsset(deps, userId, kind);
};

export const createProfileMediaService = (deps: AuthDependencies): ProfileMediaService => ({
  async uploadAvatar({ userId, file }: UploadAvatarInput) {
    const avatar = await uploadProfileMedia(deps, {
      userId,
      kind: 'avatar',
      file,
    });

    return {
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar,
    };
  },

  async deleteAvatar({ userId }: DeleteAvatarInput) {
    await deleteProfileMedia(deps, userId, 'avatar');

    return {
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    };
  },

  async uploadBanner({ userId, file }: UploadBannerInput) {
    const banner = await uploadProfileMedia(deps, {
      userId,
      kind: 'banner',
      file,
    });

    return {
      message: UPLOAD_BANNER_SUCCESS_MESSAGE,
      banner,
    };
  },

  async deleteBanner({ userId }: DeleteBannerInput) {
    await deleteProfileMedia(deps, userId, 'banner');

    return {
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    };
  },
});
