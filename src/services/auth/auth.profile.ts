import type { AuthService, GetProfileInput, UpdateProfileInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from './auth.messages.js';
import { toUserMediaAssetUrl } from './auth.userMedia.js';

type ProfileService = Pick<AuthService, 'getProfile' | 'updateProfile'>;

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
            kind: 'avatar',
          },
          select: {
            objectKey: true,
          },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new Error('Authenticated user could not be found for profile');
    }

    const { mediaAssets, ...profileUser } = user;

    return {
      user: {
        ...profileUser,
        avatarUrl: await toUserMediaAssetUrl(deps, mediaAssets[0]),
      },
    };
  },

  async updateProfile({ userId, displayName, bio }: UpdateProfileInput) {
    const data = {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(bio !== undefined ? { bio } : {}),
    };

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
