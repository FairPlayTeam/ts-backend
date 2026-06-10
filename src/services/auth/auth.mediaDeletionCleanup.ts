import { HOUR_MS, MINUTE_MS } from '../../config/constants.js';
import type {
  AuthService,
  CleanupPendingUserMediaDeletionsInput,
  CleanupPendingUserMediaDeletionsResult,
} from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE } from './auth.messages.js';

type MediaDeletionCleanupService = Pick<AuthService, 'cleanupPendingUserMediaDeletions'>;

const DEFAULT_MEDIA_DELETION_CLEANUP_LIMIT = 50;
const MAX_MEDIA_DELETION_CLEANUP_LIMIT = 200;
const LAST_ERROR_MAX_LENGTH = 1000;
const MAX_RETRY_DELAY_MS = 24 * HOUR_MS;

const normalizeCleanupLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MEDIA_DELETION_CLEANUP_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_MEDIA_DELETION_CLEANUP_LIMIT);
};

const getRetryDelayMs = (attempts: number): number =>
  Math.min(2 ** Math.max(attempts - 1, 0) * MINUTE_MS, MAX_RETRY_DELAY_MS);

const getNextAttemptAt = (now: Date, attempts: number): Date =>
  new Date(now.getTime() + getRetryDelayMs(attempts));

const serializeCleanupError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);

  return message.slice(0, LAST_ERROR_MAX_LENGTH);
};

export const createMediaDeletionCleanupService = (
  deps: AuthDependencies,
): MediaDeletionCleanupService => ({
  async cleanupPendingUserMediaDeletions({
    pendingBefore,
    limit,
  }: CleanupPendingUserMediaDeletionsInput): Promise<CleanupPendingUserMediaDeletionsResult> {
    const jobs = await deps.prisma.userMediaDeletionJob.findMany({
      where: {
        nextAttemptAt: {
          lte: pendingBefore,
        },
      },
      select: {
        id: true,
        objectKey: true,
        attempts: true,
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: normalizeCleanupLimit(limit),
    });

    let mediaObjectsDeleted = 0;
    let mediaObjectDeletionJobsFailed = 0;

    for (const job of jobs) {
      try {
        await deps.objectStorage.deleteObject(job.objectKey);
        await deps.prisma.userMediaDeletionJob.deleteMany({
          where: {
            id: job.id,
          },
        });
        mediaObjectsDeleted += 1;
      } catch (err) {
        mediaObjectDeletionJobsFailed += 1;
        const attempts = job.attempts + 1;
        const retryFrom = deps.clock.now();

        await deps.prisma.userMediaDeletionJob.updateMany({
          where: {
            id: job.id,
          },
          data: {
            attempts,
            lastError: serializeCleanupError(err),
            nextAttemptAt: getNextAttemptAt(retryFrom, attempts),
          },
        });
        deps.logger.warn(
          { err, objectKey: job.objectKey, attempts },
          'Queued user media object deletion failed',
        );
      }
    }

    return {
      message: CLEANUP_PENDING_USER_MEDIA_DELETIONS_SUCCESS_MESSAGE,
      mediaObjectsDeleted,
      mediaObjectDeletionJobsFailed,
    };
  },
});
