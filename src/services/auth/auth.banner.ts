import type { AuthService, DeleteBannerInput, UploadBannerInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { DELETE_BANNER_SUCCESS_MESSAGE, UPLOAD_BANNER_SUCCESS_MESSAGE } from './auth.messages.js';
import {
  deleteUserMediaAsset,
  toUserMediaAssetResult,
  uploadUserMediaAsset,
} from './auth.userMedia.js';

type BannerService = Pick<AuthService, 'uploadBanner' | 'deleteBanner'>;

const BANNER_KIND = 'banner' as const;

export const createBannerService = (deps: AuthDependencies): BannerService => ({
  async uploadBanner({ userId, file }: UploadBannerInput) {
    const banner = await uploadUserMediaAsset(deps, {
      userId,
      kind: BANNER_KIND,
      file,
    });

    return {
      message: UPLOAD_BANNER_SUCCESS_MESSAGE,
      banner: await toUserMediaAssetResult(deps, banner),
    };
  },

  async deleteBanner({ userId }: DeleteBannerInput) {
    await deleteUserMediaAsset(deps, userId, BANNER_KIND);

    return {
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    };
  },
});
