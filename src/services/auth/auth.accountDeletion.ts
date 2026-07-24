import { Prisma } from '@prisma/client';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import { requestExternalResourceAbsence } from '../externalResources.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from './auth.messages.js';
import { reauthenticateSensitiveAction } from './auth.reauthentication.js';
import type { AuthAccountPort, DeleteAccountInput } from './types/account.types.js';

type AccountDeletionService = Pick<AuthAccountPort, 'deleteAccount'>;

const ALL_EXTERNAL_RESOURCE_ROLES = [
  'source',
  'hls_artifacts',
  'thumbnail_prefix',
  'user_media',
] as const;

export const createAccountDeletionService = (deps: AuthDependencies): AccountDeletionService => ({
  async deleteAccount({ userId, currentPassword }: DeleteAccountInput) {
    await reauthenticateSensitiveAction(deps, { userId, currentPassword });
    const requestedAt = deps.clock.now();
    const targets = await runSerializableTransaction(deps.prisma, async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`
            SELECT "id"
            FROM "video_transcode_jobs"
            WHERE "video_id" IN (
              SELECT "id"
              FROM "videos"
              WHERE "owner_id" = CAST(${userId} AS UUID)
            )
            FOR UPDATE
          `,
      );

      const targets = await tx.externalResourceTarget.findMany({
        where: {
          userId,
          state: {
            not: 'confirmed_absent',
          },
        },
        select: {
          id: true,
          role: true,
        },
      });

      for (const target of targets) {
        await requestExternalResourceAbsence(tx, target.id, requestedAt);
      }

      await tx.user.deleteMany({
        where: { id: userId },
      });

      return targets;
    });

    await Promise.all(
      targets.map(async ({ id: targetId }) => {
        try {
          await deps.externalResources.reconcileTarget({
            targetId,
            roles: ALL_EXTERNAL_RESOURCE_ROLES,
          });
        } catch (error) {
          deps.logger.warn(
            { err: error, targetId, userId },
            'Immediate external resource reconciliation failed after account deletion',
          );
        }
      }),
    );
    const mediaCleanupQueued = targets.filter(({ role }) => role === 'user_media').length;

    return {
      message:
        targets.length > 0
          ? DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE
          : DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued,
      externalCleanupQueued: targets.length,
    };
  },
});
