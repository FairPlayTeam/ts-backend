import type { AuthService, DeleteAccountInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from './auth.messages.js';
import {
  deleteStoredUserMediaObjectsAfterStateChange,
  queueUserMediaObjectDeletions,
} from './auth.userMedia.js';

type AccountDeletionService = Pick<AuthService, 'deleteAccount'>;

export const createAccountDeletionService = (deps: AuthDependencies): AccountDeletionService => ({
  async deleteAccount({ userId }: DeleteAccountInput) {
    const objectKeys = await deps.prisma.$transaction(async (tx) => {
      const mediaAssets = await tx.userMediaAsset.findMany({
        where: { userId },
        select: {
          objectKey: true,
        },
      });

      await tx.session.deleteMany({
        where: { userId },
      });

      await tx.emailVerificationToken.deleteMany({
        where: { userId },
      });

      await tx.passwordResetToken.deleteMany({
        where: { userId },
      });

      const objectKeys = mediaAssets.map((asset) => asset.objectKey);

      await queueUserMediaObjectDeletions(tx, objectKeys);

      await tx.user.deleteMany({
        where: { id: userId },
      });

      return objectKeys;
    });

    const cleanupResult = await deleteStoredUserMediaObjectsAfterStateChange(
      deps,
      userId,
      objectKeys,
    );

    return {
      message:
        cleanupResult.queuedCount > 0
          ? DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE
          : DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: cleanupResult.queuedCount,
    };
  },
});
