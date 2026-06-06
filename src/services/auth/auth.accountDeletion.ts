import type { AuthService, DeleteAccountInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { DELETE_ACCOUNT_SUCCESS_MESSAGE } from './auth.messages.js';
import { deleteStoredUserMediaObjects } from './auth.userMedia.js';

type AccountDeletionService = Pick<AuthService, 'deleteAccount'>;

export const createAccountDeletionService = (deps: AuthDependencies): AccountDeletionService => ({
  async deleteAccount({ userId }: DeleteAccountInput) {
    await deleteStoredUserMediaObjects(deps, userId);

    await deps.prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({
        where: { userId },
      });

      await tx.emailVerificationToken.deleteMany({
        where: { userId },
      });

      await tx.passwordResetToken.deleteMany({
        where: { userId },
      });

      await tx.user.deleteMany({
        where: { id: userId },
      });
    });

    return { message: DELETE_ACCOUNT_SUCCESS_MESSAGE };
  },
});
