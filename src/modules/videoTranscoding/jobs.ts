import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { HOUR_MS, MINUTE_MS } from '../../config/constants.js';
import { getCappedExponentialDelayMs } from '../../lib/retryBackoff.js';
import type { VideoTranscodingDependencies } from './dependencies.js';
import {
  VideoTranscodeOwnershipLostError,
  VideoTranscodeSourceNotCurrentError,
  type ClaimedVideoTranscodeJob,
} from './types.js';

const TRANSCODE_RETRY_MAX_DELAY_MS = 24 * HOUR_MS;
const LAST_ERROR_MAX_LENGTH = 1_000;
export const TRANSCODE_HEARTBEAT_STALE_MS = 30_000;

const serializeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX_LENGTH);

export const getVideoTranscodeRetryDelayMs = (attempts: number): number =>
  getCappedExponentialDelayMs(attempts, MINUTE_MS, TRANSCODE_RETRY_MAX_DELAY_MS);

export const getAvailableVideoTranscodeSlots = (
  maxConcurrentJobs: number,
  activeJobs: number,
): number => Math.max(0, maxConcurrentJobs - activeJobs);

const failExhaustedAbandonedJobs = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'prisma'>,
): Promise<void> => {
  const now = deps.clock.now();
  const staleBefore = new Date(now.getTime() - TRANSCODE_HEARTBEAT_STALE_MS);

  await deps.prisma.$executeRaw(
    Prisma.sql`
      WITH exhausted AS (
        SELECT "id"
        FROM "video_transcode_jobs"
        WHERE "status" = 'processing'
          AND ("heartbeat_at" IS NULL OR "heartbeat_at" <= ${staleBefore})
          AND "attempts" >= "max_attempts"
        FOR UPDATE SKIP LOCKED
      ),
      failed AS (
        UPDATE "video_transcode_jobs" AS job
        SET
          "status" = 'failed',
          "last_error" = COALESCE(
            "last_error",
            'Transcode execution was abandoned after its final attempt'
          ),
          "failed_at" = ${now},
          "heartbeat_at" = NULL,
          "execution_id" = NULL,
          "updated_at" = ${now}
        FROM exhausted
        WHERE job."id" = exhausted."id"
        RETURNING job."video_id", job."source_object_key"
      )
      UPDATE "videos" AS video
      SET
        "processing_status" = 'failed',
        "transcode_error" = 'Transcode execution was abandoned after its final attempt',
        "updated_at" = ${now}
      FROM failed
      WHERE video."id" = failed."video_id"
        AND video."source_object_key" = failed."source_object_key"
    `,
  );
};

export const claimNextVideoTranscodeJob = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'executionIdGenerator' | 'prisma'>,
): Promise<ClaimedVideoTranscodeJob | null> => {
  await failExhaustedAbandonedJobs(deps);
  const now = deps.clock.now();
  const staleBefore = new Date(now.getTime() - TRANSCODE_HEARTBEAT_STALE_MS);
  const executionId = deps.executionIdGenerator?.generate() ?? randomUUID();
  const claimed = await deps.prisma.$queryRaw<ClaimedVideoTranscodeJob[]>(
    Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "video_transcode_jobs"
        WHERE "attempts" < "max_attempts"
          AND (
            (
              "status" = 'queued'
              AND "next_attempt_at" <= ${now}
            )
            OR
            (
              "status" = 'processing'
              AND ("heartbeat_at" IS NULL OR "heartbeat_at" <= ${staleBefore})
            )
          )
        ORDER BY "next_attempt_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "video_transcode_jobs" AS job
      SET
        "status" = 'processing',
        "attempts" = job."attempts" + 1,
        "execution_id" = CAST(${executionId} AS UUID),
        "heartbeat_at" = ${now},
        "started_at" = ${now},
        "completed_at" = NULL,
        "failed_at" = NULL,
        "last_error" = NULL,
        "updated_at" = ${now}
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING
        job."id",
        job."video_id" AS "videoId",
        job."source_object_key" AS "sourceObjectKey",
        job."attempts",
        job."max_attempts" AS "maxAttempts",
        job."execution_id"::text AS "executionId"
    `,
  );

  return claimed[0] ?? null;
};

export const renewJobHeartbeat = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'prisma'>,
  job: ClaimedVideoTranscodeJob,
): Promise<void> => {
  const renewed = await deps.prisma.videoTranscodeJob.updateMany({
    where: {
      id: job.id,
      status: 'processing',
      executionId: job.executionId,
    },
    data: {
      heartbeatAt: deps.clock.now(),
    },
  });

  if (renewed.count === 0) {
    throw new VideoTranscodeOwnershipLostError();
  }
};

export const findCompletedSource = async (
  deps: Pick<VideoTranscodingDependencies, 'prisma'>,
  job: ClaimedVideoTranscodeJob,
) => {
  const source = await deps.prisma.videoUploadSession.findFirst({
    where: {
      videoId: job.videoId,
      objectKey: job.sourceObjectKey,
      status: 'completed',
    },
    select: {
      id: true,
      userId: true,
      bucket: true,
      objectKey: true,
      sourceThumbnail: {
        select: {
          bucket: true,
          externalResourceTargetId: true,
          objectKey: true,
          externalResourceTarget: {
            select: {
              bucket: true,
              generation: true,
              goal: true,
              role: true,
              selector: true,
              selectorKind: true,
              state: true,
              userId: true,
              videoId: true,
            },
          },
        },
      },
    },
  });

  if (!source) {
    throw new VideoTranscodeSourceNotCurrentError();
  }

  const sourceThumbnail = source.sourceThumbnail;

  if (
    sourceThumbnail &&
    (sourceThumbnail.bucket !== sourceThumbnail.externalResourceTarget.bucket ||
      sourceThumbnail.objectKey !== sourceThumbnail.externalResourceTarget.selector ||
      sourceThumbnail.externalResourceTarget.userId !== source.userId ||
      sourceThumbnail.externalResourceTarget.videoId !== job.videoId ||
      sourceThumbnail.externalResourceTarget.generation !== source.id ||
      sourceThumbnail.externalResourceTarget.role !== 'source_thumbnail' ||
      sourceThumbnail.externalResourceTarget.goal !== 'present' ||
      sourceThumbnail.externalResourceTarget.state !== 'confirmed_present' ||
      sourceThumbnail.externalResourceTarget.selectorKind !== 'exact')
  ) {
    throw new VideoTranscodeSourceNotCurrentError();
  }

  return source;
};

export const assertCurrentSourceAndOwnership = async (
  deps: Pick<VideoTranscodingDependencies, 'prisma'>,
  job: ClaimedVideoTranscodeJob,
  sourceUploadSessionId: string,
): Promise<void> => {
  const current = await deps.prisma.video.findFirst({
    where: {
      id: job.videoId,
      sourceUploadSessionId,
      sourceObjectKey: job.sourceObjectKey,
      transcodeJobs: {
        some: {
          id: job.id,
          status: 'processing',
          executionId: job.executionId,
        },
      },
    },
    select: { id: true },
  });

  if (!current) {
    throw new VideoTranscodeSourceNotCurrentError();
  }
};

export const updateJobAfterFailure = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'prisma'>,
  job: ClaimedVideoTranscodeJob,
  error: unknown,
  forceTerminal = false,
): Promise<void> => {
  const failedAt = deps.clock.now();
  const terminal = forceTerminal || job.attempts >= job.maxAttempts;
  const nextAttemptAt = new Date(failedAt.getTime() + getVideoTranscodeRetryDelayMs(job.attempts));

  await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.videoTranscodeJob.updateMany({
      where: {
        id: job.id,
        status: 'processing',
        executionId: job.executionId,
      },
      data: terminal
        ? {
            status: 'failed',
            lastError: serializeError(error),
            heartbeatAt: null,
            executionId: null,
            failedAt,
          }
        : {
            status: 'queued',
            lastError: serializeError(error),
            nextAttemptAt,
            heartbeatAt: null,
            executionId: null,
          },
    });

    if (updated.count === 0) {
      throw new VideoTranscodeOwnershipLostError();
    }

    await tx.video.updateMany({
      where: {
        id: job.videoId,
        sourceObjectKey: job.sourceObjectKey,
      },
      data: terminal
        ? {
            processingStatus: 'failed',
            transcodeError: serializeError(error),
          }
        : {
            processingStatus: 'queued',
            transcodeError: null,
          },
    });
  });
};

export const requeueJobForShutdown = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'prisma'>,
  job: ClaimedVideoTranscodeJob,
): Promise<void> => {
  const now = deps.clock.now();

  await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.videoTranscodeJob.updateMany({
      where: {
        id: job.id,
        status: 'processing',
        executionId: job.executionId,
      },
      data: {
        status: 'queued',
        attempts: {
          decrement: 1,
        },
        executionId: null,
        heartbeatAt: null,
        nextAttemptAt: now,
      },
    });

    if (updated.count > 0) {
      await tx.video.updateMany({
        where: {
          id: job.videoId,
          sourceObjectKey: job.sourceObjectKey,
        },
        data: {
          processingStatus: 'queued',
        },
      });
    }
  });
};
