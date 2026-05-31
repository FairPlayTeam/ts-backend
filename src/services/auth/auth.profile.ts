import type { AuthService, UpdateProfileInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from './auth.messages.js';

type ProfileService = Pick<AuthService, 'updateProfile'>;

export const createProfileService = (deps: AuthDependencies): ProfileService => ({
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
