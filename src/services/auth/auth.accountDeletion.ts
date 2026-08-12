import { Prisma } from '@prisma/client';
import {
  getSerializableTransactionRetryDelayMs,
  isSerializableTransactionConflictError,
  runSerializableTransaction,
} from '../../lib/prismaTransactions.js';
import { AccountDeletionTemporarilyUnavailableError } from '../auth.errors.js';
import { requestExternalResourceAbsence } from '../externalResources.js';
import { softDeleteLockedVideoComments } from '../videos/videoCommentLifecycle.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from './auth.messages.js';
import { reauthenticateSensitiveAction } from './auth.reauthentication.js';
import type { AuthAccountPort, DeleteAccountInput } from './types/account.types.js';

type AccountDeletionService = Pick<AuthAccountPort, 'deleteAccount'>;

const ACCOUNT_DELETION_TRANSACTION_MAX_ATTEMPTS = 5;

type LockedAccountComment = {
  id: string;
  isAuthored: boolean;
};

export const createAccountDeletionService = (deps: AuthDependencies): AccountDeletionService => ({
  async deleteAccount({ userId, currentPassword }: DeleteAccountInput) {
    await reauthenticateSensitiveAction(deps, { userId, currentPassword });
    const requestedAt = deps.clock.now();
    const targets = await runSerializableTransaction(
      deps.prisma,
      async (tx) => {
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

        // User-rating, user-view, and comment-author cascades do not maintain denormalized
        // video aggregates. Lock every affected video in a stable order before applying deltas.
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
            OR "id" IN (
              SELECT "video_id"
              FROM "comments"
              WHERE "author_id" = CAST(${userId} AS UUID)
                AND "deleted_at" IS NULL
            )
          ORDER BY "id"
          FOR UPDATE
        `,
        );
        // Comment likes mutate a comment-owned aggregate and therefore lock comment rows directly.
        // Keep account cleanup in the same stable order before changing emitted or received likes.
        const lockedComments = await tx.$queryRaw<LockedAccountComment[]>(
          Prisma.sql`
          SELECT
            c."id"::text AS "id",
            (c."author_id" = CAST(${userId} AS UUID) AND c."deleted_at" IS NULL) AS "isAuthored"
          FROM "comments" AS c
          WHERE (
              c."author_id" = CAST(${userId} AS UUID)
              AND c."deleted_at" IS NULL
            )
            OR c."id" IN (
              SELECT "comment_id"
              FROM "comment_likes"
              WHERE "user_id" = CAST(${userId} AS UUID)
            )
          ORDER BY c."id"
          FOR UPDATE
        `,
        );
        // These repairs need a source-derived delta that differs for each target row. Prisma
        // updateMany can apply only one fixed delta and cannot express the grouped UPDATE ... FROM
        // shape, so keep all four repairs set-based while their target rows are locked.
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
        await tx.$executeRaw(
          Prisma.sql`
          UPDATE "videos" AS v
          SET "comment_count" = v."comment_count" - authored."comment_count"
          FROM (
            SELECT
              "video_id",
              COUNT(*)::integer AS "comment_count"
            FROM "comments"
            WHERE "author_id" = CAST(${userId} AS UUID)
              AND "deleted_at" IS NULL
            GROUP BY "video_id"
          ) AS authored
          WHERE authored."video_id" = v."id"
        `,
        );
        await tx.$executeRaw(
          Prisma.sql`
          UPDATE "comments" AS c
          SET "like_count" = c."like_count" - emitted."like_count"
          FROM (
            SELECT
              "comment_id",
              COUNT(*)::integer AS "like_count"
            FROM "comment_likes"
            WHERE "user_id" = CAST(${userId} AS UUID)
            GROUP BY "comment_id"
          ) AS emitted
          WHERE emitted."comment_id" = c."id"
        `,
        );
        await tx.commentLike.deleteMany({
          where: {
            userId,
          },
        });
        await softDeleteLockedVideoComments(tx, {
          commentIds: lockedComments.filter(({ isAuthored }) => isAuthored).map(({ id }) => id),
          deletedAt: requestedAt,
          deletionOrigin: 'account_deletion',
        });

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
      },
      {
        maxAttempts: ACCOUNT_DELETION_TRANSACTION_MAX_ATTEMPTS,
        retryDelayMs: getSerializableTransactionRetryDelayMs,
      },
    ).catch((err: unknown) => {
      if (isSerializableTransactionConflictError(err)) {
        throw new AccountDeletionTemporarilyUnavailableError(err);
      }

      throw err;
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
