import { AuthService } from '../auth.types.js';
import { AuthDependencies } from './auth.dependencies.js';
import { UpdateProfileInput } from '../auth.types.js';
import { UPDATE_PROFILE_SUCCESS_MESSAGE } from './auth.messages.js';

type profileService = Pick<AuthService, 'updateProfile'>;

export const createProfileService = (deps: AuthDependencies): profileService => ({
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
