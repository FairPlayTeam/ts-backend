import type { AuthDependencies } from './auth.dependencies.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from './auth.messages.js';
import { toUserMediaAssetUrl } from './auth.userMedia.js';
import type { UserMediaKind } from '../userMedia/userMedia.types.js';
import { ProfileUpdateEmptyError } from '../auth.errors.js';
import type {
  AuthProfilePort,
  GetProfileInput,
  UpdateProfileInput,
} from './types/profile.types.js';

type ProfileService = AuthProfilePort;

type ProfileMediaAsset = {
  kind: UserMediaKind;
  objectKey: string;
};

const getProfileMediaAsset = (
  mediaAssets: ProfileMediaAsset[],
  kind: UserMediaKind,
): ProfileMediaAsset | undefined => mediaAssets.find((asset) => asset.kind === kind);

export const createProfileService = (deps: AuthDependencies): ProfileService => ({
  async getProfile({ userId }: GetProfileInput) {
    const user = await deps.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        mediaAssets: {
          where: {
            kind: {
              in: ['avatar', 'banner'],
            },
          },
          select: {
            kind: true,
            objectKey: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('Authenticated user could not be found for profile');
    }

    const { mediaAssets, ...profileUser } = user;
    const [avatarUrl, bannerUrl] = await Promise.all([
      toUserMediaAssetUrl(deps, getProfileMediaAsset(mediaAssets, 'avatar')),
      toUserMediaAssetUrl(deps, getProfileMediaAsset(mediaAssets, 'banner')),
    ]);

    return {
      user: {
        ...profileUser,
        avatarUrl,
        bannerUrl,
      },
    };
  },

  async updateProfile({ userId, displayName, bio }: UpdateProfileInput) {
    const data = {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(bio !== undefined ? { bio } : {}),
    };

    if (Object.keys(data).length === 0) {
      throw new ProfileUpdateEmptyError();
    }

    const user = await deps.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
      },
    });

    return {
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
      user,
    };
  },
});
