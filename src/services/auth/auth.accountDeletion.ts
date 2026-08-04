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

      // User-rating and user-view cascades do not maintain denormalized video aggregates.
      // Lock every affected video in a stable order before applying those deltas.
      await tx.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "videos"
          WHERE "owner_id" = CAST(${userId} AS UUID)
            OR "id" IN (
              SELECT "video_id"
              FROM "video_ratings"
              WHERE "user_id" = CAST(${userId} AS UUID)
            )
            OR "id" IN (
              SELECT "video_id"
              FROM "video_views"
              WHERE "user_id" = CAST(${userId} AS UUID)
            )
          ORDER BY "id"
          FOR UPDATE
        `,
      );
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE "videos" AS v
          SET
            "rating_sum" = v."rating_sum" - vr."value",
            "rating_count" = v."rating_count" - 1
          FROM "video_ratings" AS vr
          WHERE vr."user_id" = CAST(${userId} AS UUID)
            AND vr."video_id" = v."id"
        `,
      );
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE "videos" AS v
          SET "view_count" = v."view_count" - viewed."view_count"
          FROM (
            SELECT
              "video_id",
              COUNT(*)::integer AS "view_count"
            FROM "video_views"
            WHERE "user_id" = CAST(${userId} AS UUID)
            GROUP BY "video_id"
          ) AS viewed
          WHERE viewed."video_id" = v."id"
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
      targets
        .filter(({ role }) => role === 'user_media')
        .map(async ({ id: targetId }) => {
          try {
            await deps.externalResources.reconcileTarget({
              targetId,
              roles: ['user_media'],
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
