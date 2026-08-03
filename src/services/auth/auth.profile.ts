import type { AuthDependencies } from './auth.dependencies.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from './auth.messages.js';
import { isPrismaRecordNotFoundError } from './auth.prismaErrors.js';
import {
  profileMediaAssetSelect,
  profileMediaAssetWhere,
  toProfileMediaUrls,
} from '../userMedia/userMedia.profileAssets.js';
import { AuthenticatedUserNotFoundError, ProfileUpdateEmptyError } from '../auth.errors.js';
import type {
  AuthProfilePort,
  GetProfileInput,
  UpdateProfileInput,
} from './types/profile.types.js';

type ProfileService = AuthProfilePort;

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
          where: profileMediaAssetWhere,
          select: profileMediaAssetSelect,
        },
      },
    });

    if (!user) {
      throw new AuthenticatedUserNotFoundError();
    }

    const { mediaAssets, ...profileUser } = user;
    const { avatarUrl, bannerUrl } = toProfileMediaUrls(profileUser.username, mediaAssets);

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

    const user = await deps.prisma.user
      .update({
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
      })
      .catch((err: unknown) => {
        if (isPrismaRecordNotFoundError(err)) {
          throw new AuthenticatedUserNotFoundError(err);
        }

        throw err;
      });

    return {
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
      user,
    };
  },
});
