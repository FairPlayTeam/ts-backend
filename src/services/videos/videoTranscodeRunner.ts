import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { HOUR_MS, MINUTE_MS } from '../../config/constants.js';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import {
  requestExternalResourceAbsence,
  type ExternalResourceReconciliationHandler,
} from '../externalResources.js';
import { buildVideoArtifactManifest, type VideoArtifactManifest } from './videoObjectKeys.js';
import { toVideoRenditionQuality } from './videoHls.js';
import {
  probeVideo,
  isTerminalVideoTranscodeError,
  selectVideoTranscodeProfiles,
  transcodeVideoArtifacts,
  type GeneratedVideoArtifacts,
  type VideoProbe,
  type VideoTranscodeLimits,
} from './videoTranscode.js';

const TRANSCODE_POLL_INTERVAL_MS = 2_000;
const TRANSCODE_HEARTBEAT_INTERVAL_MS = 10_000;
const TRANSCODE_HEARTBEAT_STALE_MS = 30_000;
const TRANSCODE_RETRY_MAX_DELAY_MS = 24 * HOUR_MS;
const LAST_ERROR_MAX_LENGTH = 1_000;
const ABANDONED_GENERATION_MAINTENANCE_BATCH_SIZE = 50;
const VIDEO_ARTIFACT_RESOURCE_ROLES = ['hls_artifacts', 'thumbnail_prefix'] as const;

type RunnerPrisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'externalResourceTarget'
  | 'video'
  | 'videoArtifactGeneration'
  | 'videoRendition'
  | 'videoSourceThumbnail'
  | 'videoTranscodeJob'
  | 'videoUploadSession'
>;

type VideoTranscodeRunnerDependencies = {
  prisma: RunnerPrisma;
  objectStorage: Pick<ObjectStorage, 'bucket' | 'downloadObject' | 'headObject' | 'putObject'>;
  clock: {
    now(): Date;
  };
  config: VideoTranscodeLimits & {
    maxConcurrentJobs: number;
    threadsPerJob: number;
  };
  binaries?: {
    ffmpegPath?: string;
    ffprobePath?: string;
  };
  executionIdGenerator?: {
    generate(): string;
  };
  generationIdGenerator?: {
    generate(): string;
  };
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
    warn(data: object, message: string): void;
  };
};

export type ClaimedVideoTranscodeJob = {
  id: string;
  videoId: string;
  sourceObjectKey: string;
  attempts: number;
  maxAttempts: number;
  executionId: string;
};

type ReservedArtifactGeneration = {
  id: string;
  sourceUploadSessionId: string;
  userId: string;
  bucket: string;
};

export class VideoTranscodeOwnershipLostError extends Error {
  constructor() {
    super('Video transcode job ownership was lost');
    this.name = 'VideoTranscodeOwnershipLostError';
  }
}

class VideoTranscodeSourceNotCurrentError extends Error {
  constructor() {
    super('Video transcode source is no longer current');
    this.name = 'VideoTranscodeSourceNotCurrentError';
  }
}

class VideoTranscodeRunnerShutdownError extends Error {
  constructor() {
    super('Video transcode runner is shutting down');
    this.name = 'VideoTranscodeRunnerShutdownError';
  }
}

const serializeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_MAX_LENGTH);

export const getVideoTranscodeRetryDelayMs = (attempts: number): number =>
  Math.min(2 ** Math.max(attempts - 1, 0) * MINUTE_MS, TRANSCODE_RETRY_MAX_DELAY_MS);

export const getAvailableVideoTranscodeSlots = (
  maxConcurrentJobs: number,
  activeJobs: number,
): number => Math.max(0, maxConcurrentJobs - activeJobs);

const failExhaustedAbandonedJobs = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'prisma'>,
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
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'executionIdGenerator' | 'prisma'>,
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

const renewJobHeartbeat = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'prisma'>,
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

const findCompletedSource = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'prisma'>,
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

const assertCurrentSourceAndOwnership = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'prisma'>,
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

const reserveArtifactGeneration = async (
  deps: Pick<
    VideoTranscodeRunnerDependencies,
    'clock' | 'generationIdGenerator' | 'objectStorage' | 'prisma'
  >,
  job: ClaimedVideoTranscodeJob,
  source: Awaited<ReturnType<typeof findCompletedSource>>,
): Promise<ReservedArtifactGeneration> => {
  const generationId = deps.generationIdGenerator?.generate() ?? randomUUID();
  const manifest = buildVideoArtifactManifest(source.userId, job.videoId, generationId, []);
  const now = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    const ownedJob = await tx.videoTranscodeJob.findFirst({
      where: {
        id: job.id,
        videoId: job.videoId,
        sourceObjectKey: job.sourceObjectKey,
        status: 'processing',
        executionId: job.executionId,
      },
      select: { id: true },
    });
    const currentVideo = await tx.video.findFirst({
      where: {
        id: job.videoId,
        sourceUploadSessionId: source.id,
        sourceObjectKey: job.sourceObjectKey,
      },
      select: { id: true },
    });

    if (!ownedJob) {
      throw new VideoTranscodeOwnershipLostError();
    }

    if (!currentVideo) {
      throw new VideoTranscodeSourceNotCurrentError();
    }

    await tx.videoArtifactGeneration.create({
      data: {
        id: generationId,
        videoId: job.videoId,
        sourceUploadSessionId: source.id,
        transcodeJobId: job.id,
        executionId: job.executionId,
        bucket: deps.objectStorage.bucket,
        state: 'writing',
        hlsMasterObjectKey: manifest.master.objectKey,
        thumbnailObjectKey: manifest.thumbnail.objectKey,
      },
      select: { id: true },
    });
    await tx.externalResourceTarget.createMany({
      data: [
        {
          userId: source.userId,
          videoId: job.videoId,
          bucket: deps.objectStorage.bucket,
          selector: manifest.hlsPrefix,
          selectorKind: 'prefix',
          role: 'hls_artifacts',
          generation: generationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'writing',
          nextAttemptAt: new Date(now.getTime() + HOUR_MS),
        },
        {
          userId: source.userId,
          videoId: job.videoId,
          bucket: deps.objectStorage.bucket,
          selector: manifest.thumbnailPrefix,
          selectorKind: 'prefix',
          role: 'thumbnail_prefix',
          generation: generationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'writing',
          nextAttemptAt: new Date(now.getTime() + HOUR_MS),
        },
      ],
    });
  });

  return {
    id: generationId,
    sourceUploadSessionId: source.id,
    userId: source.userId,
    bucket: deps.objectStorage.bucket,
  };
};

export const publishVideoArtifactGeneration = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'prisma'>,
  {
    generation,
    job,
    manifest,
    probe,
    sourceThumbnailTargetId,
  }: {
    generation: ReservedArtifactGeneration;
    job: ClaimedVideoTranscodeJob;
    manifest: VideoArtifactManifest;
    probe: VideoProbe;
    sourceThumbnailTargetId?: string;
  },
): Promise<void> => {
  const now = deps.clock.now();

  await runSerializableTransaction(deps.prisma, async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "video_transcode_jobs"
        WHERE "id" = CAST(${job.id} AS UUID)
        FOR UPDATE
      `,
    );

    const ownedJob = await tx.videoTranscodeJob.findFirst({
      where: {
        id: job.id,
        videoId: job.videoId,
        sourceObjectKey: job.sourceObjectKey,
        status: 'processing',
        executionId: job.executionId,
      },
      select: { id: true },
    });
    const currentVideo = await tx.video.findFirst({
      where: {
        id: job.videoId,
        sourceUploadSessionId: generation.sourceUploadSessionId,
        sourceObjectKey: job.sourceObjectKey,
      },
      select: {
        id: true,
        activeArtifactGenerationId: true,
      },
    });
    const writableGeneration = await tx.videoArtifactGeneration.findFirst({
      where: {
        id: generation.id,
        videoId: job.videoId,
        sourceUploadSessionId: generation.sourceUploadSessionId,
        transcodeJobId: job.id,
        executionId: job.executionId,
        state: 'writing',
      },
      select: { id: true },
    });

    if (!ownedJob) {
      throw new VideoTranscodeOwnershipLostError();
    }

    if (!currentVideo) {
      throw new VideoTranscodeSourceNotCurrentError();
    }

    if (!writableGeneration) {
      throw new Error('Artifact generation is no longer writable');
    }

    if (sourceThumbnailTargetId) {
      const sourceThumbnail = await tx.videoSourceThumbnail.findFirst({
        where: {
          uploadSessionId: generation.sourceUploadSessionId,
          externalResourceTargetId: sourceThumbnailTargetId,
          externalResourceTarget: {
            is: {
              userId: generation.userId,
              videoId: job.videoId,
              generation: generation.sourceUploadSessionId,
              role: 'source_thumbnail',
              goal: 'present',
              state: 'confirmed_present',
              selectorKind: 'exact',
            },
          },
        },
        select: {
          id: true,
        },
      });

      if (!sourceThumbnail) {
        throw new VideoTranscodeSourceNotCurrentError();
      }
    }

    const hlsTargetUpdated = await tx.externalResourceTarget.updateMany({
      where: {
        videoId: job.videoId,
        generation: generation.id,
        role: 'hls_artifacts',
        goal: 'present',
        state: 'writing',
      },
      data: {
        state: 'confirmed_present',
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
      },
    });
    const thumbnailTargetUpdated = await tx.externalResourceTarget.updateMany({
      where: {
        videoId: job.videoId,
        generation: generation.id,
        role: 'thumbnail_prefix',
        goal: 'present',
        state: 'writing',
      },
      data: {
        state: 'confirmed_present',
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
      },
    });

    if (hlsTargetUpdated.count !== 1 || thumbnailTargetUpdated.count !== 1) {
      throw new Error('Artifact generation targets are no longer writable');
    }

    await tx.videoRendition.createMany({
      data: manifest.renditions.map((rendition) => ({
        artifactGenerationId: generation.id,
        quality: toVideoRenditionQuality(rendition.quality),
        width: rendition.width,
        height: rendition.height,
        bitrate: rendition.videoBitrate,
        playlistObjectKey: rendition.playlistObjectKey,
        segmentPrefix: rendition.segmentPrefix,
        codec: 'h264',
        container: 'hls',
      })),
    });
    const activated = await tx.videoArtifactGeneration.updateMany({
      where: {
        id: generation.id,
        state: 'writing',
        executionId: job.executionId,
      },
      data: {
        state: 'active',
        hlsMasterObjectKey: manifest.master.objectKey,
        thumbnailObjectKey: manifest.thumbnail.objectKey,
        activatedAt: now,
      },
    });

    if (activated.count !== 1) {
      throw new Error('Artifact generation activation lost its write fence');
    }

    const previousGenerationId = currentVideo.activeArtifactGenerationId;

    if (previousGenerationId && previousGenerationId !== generation.id) {
      const retiredGeneration = await tx.videoArtifactGeneration.updateMany({
        where: {
          id: previousGenerationId,
          videoId: job.videoId,
          state: 'active',
        },
        data: {
          state: 'retiring',
        },
      });

      if (retiredGeneration.count !== 1) {
        throw new Error('Previous artifact generation could not be retired');
      }

      const previousTargets = await tx.externalResourceTarget.findMany({
        where: {
          videoId: job.videoId,
          generation: previousGenerationId,
          role: {
            in: [...VIDEO_ARTIFACT_RESOURCE_ROLES],
          },
          state: {
            not: 'confirmed_absent',
          },
        },
        select: {
          id: true,
          role: true,
        },
      });

      if (
        previousTargets.length !== 2 ||
        !previousTargets.some(({ role }) => role === 'hls_artifacts') ||
        !previousTargets.some(({ role }) => role === 'thumbnail_prefix')
      ) {
        throw new Error('Previous artifact generation cleanup targets are incomplete');
      }

      for (const target of previousTargets) {
        await requestExternalResourceAbsence(tx, target.id, now);
      }
    }

    const videoUpdated = await tx.video.updateMany({
      where: {
        id: job.videoId,
        sourceUploadSessionId: generation.sourceUploadSessionId,
        sourceObjectKey: job.sourceObjectKey,
      },
      data: {
        activeArtifactGenerationId: generation.id,
        hlsMasterObjectKey: manifest.master.objectKey,
        thumbnailObjectKey: manifest.thumbnail.objectKey,
        processingStatus: 'ready',
        durationSeconds: Math.max(1, Math.ceil(probe.durationSeconds)),
        width: probe.width,
        height: probe.height,
        transcodeError: null,
      },
    });
    const jobUpdated = await tx.videoTranscodeJob.updateMany({
      where: {
        id: job.id,
        status: 'processing',
        executionId: job.executionId,
        sourceObjectKey: job.sourceObjectKey,
      },
      data: {
        status: 'completed',
        heartbeatAt: now,
        completedAt: now,
        lastError: null,
      },
    });

    if (videoUpdated.count !== 1 || jobUpdated.count !== 1) {
      throw new VideoTranscodeOwnershipLostError();
    }

    if (sourceThumbnailTargetId) {
      await requestExternalResourceAbsence(tx, sourceThumbnailTargetId, now);
    }
  });
};

const scheduleArtifactGenerationCleanup = async (
  deps: {
    prisma: Pick<RunnerPrisma, '$transaction'>;
    clock: {
      now(): Date;
    };
  },
  generationId: string | null,
  requestedAt = deps.clock.now(),
): Promise<boolean> => {
  if (!generationId) {
    return false;
  }

  return runSerializableTransaction(deps.prisma, async (tx) => {
    const generation = await tx.videoArtifactGeneration.findFirst({
      where: {
        id: generationId,
        state: 'writing',
      },
      select: { id: true },
    });

    if (!generation) {
      return false;
    }

    const targets = await tx.externalResourceTarget.findMany({
      where: {
        generation: generationId,
        goal: 'present',
        role: {
          in: [...VIDEO_ARTIFACT_RESOURCE_ROLES],
        },
        state: {
          not: 'confirmed_absent',
        },
      },
      select: { id: true },
    });

    for (const target of targets) {
      await requestExternalResourceAbsence(tx, target.id, requestedAt);
    }

    return targets.length > 0;
  });
};

export const scheduleAbandonedVideoArtifactGenerations = async (
  deps: {
    prisma: Pick<RunnerPrisma, '$queryRaw' | '$transaction'>;
    clock: {
      now(): Date;
    };
  },
  { observedAt }: { observedAt: Date },
): Promise<{ artifactGenerationsScheduled: number }> => {
  const abandonedBefore = new Date(observedAt.getTime() - TRANSCODE_HEARTBEAT_STALE_MS);
  const candidates = await deps.prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT generation."id"::text AS "id"
      FROM "video_artifact_generations" AS generation
      INNER JOIN "video_transcode_jobs" AS job
        ON job."id" = generation."transcode_job_id"
      WHERE generation."state" = 'writing'
        AND generation."updated_at" <= ${abandonedBefore}
        AND NOT (
          job."status" = 'processing'
          AND job."execution_id" = generation."execution_id"
          AND job."heartbeat_at" > ${abandonedBefore}
        )
        AND EXISTS (
          SELECT 1
          FROM "external_resource_targets" AS target
          WHERE target."generation" = generation."id"::text
            AND target."role" IN ('hls_artifacts', 'thumbnail_prefix')
            AND target."goal" = 'present'
            AND target."state" <> 'confirmed_absent'
        )
      ORDER BY generation."updated_at" ASC, generation."id" ASC
      LIMIT ${ABANDONED_GENERATION_MAINTENANCE_BATCH_SIZE}
    `,
  );
  let artifactGenerationsScheduled = 0;

  for (const candidate of candidates) {
    if (await scheduleArtifactGenerationCleanup(deps, candidate.id, observedAt)) {
      artifactGenerationsScheduled += 1;
    }
  }

  return { artifactGenerationsScheduled };
};

export const createVideoArtifactReconciliationHandler = (clock: {
  now(): Date;
}): ExternalResourceReconciliationHandler => ({
  async finalize(tx, target) {
    if (target.goal !== 'absent') {
      return;
    }

    const remainingTargets = await tx.externalResourceTarget.count({
      where: {
        videoId: target.videoId,
        generation: target.generation,
        role: {
          in: [...VIDEO_ARTIFACT_RESOURCE_ROLES],
        },
        id: {
          not: target.id,
        },
        state: {
          not: 'confirmed_absent',
        },
      },
    });

    if (remainingTargets === 0) {
      await tx.videoArtifactGeneration.updateMany({
        where: {
          id: target.generation,
          state: {
            in: ['writing', 'retiring'],
          },
        },
        data: {
          state: 'retired',
          retiredAt: clock.now(),
        },
      });
    }
  },
});

const uploadAndVerifyArtifacts = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'objectStorage'>,
  {
    artifacts,
    bucket,
    renewOwnership,
    signal,
  }: {
    artifacts: GeneratedVideoArtifacts;
    bucket: string;
    renewOwnership: () => Promise<void>;
    signal: AbortSignal;
  },
): Promise<void> => {
  for (const artifact of artifacts.files) {
    signal.throwIfAborted();
    const body = await readFile(artifact.filePath);
    await deps.objectStorage.putObject({
      bucket,
      objectKey: artifact.objectKey,
      body,
      contentType: artifact.contentType,
    });
    await renewOwnership();
  }

  for (const artifact of artifacts.files) {
    signal.throwIfAborted();
    const persisted = await deps.objectStorage.headObject({
      bucket,
      objectKey: artifact.objectKey,
    });

    if (!persisted || persisted.sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Uploaded artifact could not be verified: ${artifact.objectKey}`);
    }
  }

  if (artifacts.renditionSegments.some((segments) => segments.length === 0)) {
    throw new Error('Uploaded rendition has no verified HLS segment');
  }
};

const updateJobAfterFailure = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'prisma'>,
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

const requeueJobForShutdown = async (
  deps: Pick<VideoTranscodeRunnerDependencies, 'clock' | 'prisma'>,
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

const processClaimedJob = async (
  deps: VideoTranscodeRunnerDependencies,
  job: ClaimedVideoTranscodeJob,
  controller: AbortController,
): Promise<void> => {
  let generation: ReservedArtifactGeneration | null = null;
  let heartbeatPromise: Promise<void> | null = null;
  const pendingHeartbeats = new Set<Promise<void>>();
  const heartbeat = async (): Promise<void> => {
    if (heartbeatPromise) {
      return heartbeatPromise;
    }

    if (controller.signal.aborted) {
      return;
    }

    const currentHeartbeat = renewJobHeartbeat(deps, job)
      .catch((error: unknown) => {
        controller.abort(error instanceof Error ? error : new VideoTranscodeOwnershipLostError());
        throw error;
      })
      .finally(() => {
        pendingHeartbeats.delete(currentHeartbeat);

        if (heartbeatPromise === currentHeartbeat) {
          heartbeatPromise = null;
        }
      });
    heartbeatPromise = currentHeartbeat;
    pendingHeartbeats.add(currentHeartbeat);
    return currentHeartbeat;
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let temporaryDirectory: string | null = null;

  try {
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, TRANSCODE_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'fairplay-transcode-'));
    const inputPath = resolve(temporaryDirectory, 'source.mp4');
    const sourceThumbnailPath = resolve(temporaryDirectory, 'source-thumbnail.webp');
    const outputDirectory = resolve(temporaryDirectory, 'artifacts');
    const source = await findCompletedSource(deps, job);
    await deps.objectStorage.downloadObject({
      bucket: source.bucket,
      objectKey: source.objectKey,
      destinationPath: inputPath,
    });
    if (source.sourceThumbnail) {
      await deps.objectStorage.downloadObject({
        bucket: source.sourceThumbnail.bucket,
        objectKey: source.sourceThumbnail.objectKey,
        destinationPath: sourceThumbnailPath,
      });
    }
    controller.signal.throwIfAborted();
    await heartbeat();
    await assertCurrentSourceAndOwnership(deps, job, source.id);
    generation = await reserveArtifactGeneration(deps, job, source);
    const probe = await probeVideo({
      ...(deps.binaries?.ffprobePath ? { ffprobePath: deps.binaries.ffprobePath } : {}),
      inputPath,
      limits: deps.config,
      signal: controller.signal,
    });
    const profiles = selectVideoTranscodeProfiles(probe);
    const manifest = buildVideoArtifactManifest(
      generation.userId,
      job.videoId,
      generation.id,
      profiles,
    );
    const artifacts = await transcodeVideoArtifacts({
      ...(deps.binaries?.ffmpegPath ? { ffmpegPath: deps.binaries.ffmpegPath } : {}),
      inputPath,
      limits: deps.config,
      manifest,
      outputDirectory,
      probe,
      signal: controller.signal,
      ...(source.sourceThumbnail ? { sourceThumbnailPath } : {}),
      threads: deps.config.threadsPerJob,
    });
    await heartbeat();
    await uploadAndVerifyArtifacts(deps, {
      artifacts,
      bucket: generation.bucket,
      renewOwnership: heartbeat,
      signal: controller.signal,
    });
    await heartbeat();
    await publishVideoArtifactGeneration(deps, {
      generation,
      job,
      manifest,
      probe,
      ...(source.sourceThumbnail
        ? { sourceThumbnailTargetId: source.sourceThumbnail.externalResourceTargetId }
        : {}),
    });
  } catch (error) {
    await scheduleArtifactGenerationCleanup(deps, generation?.id ?? null).catch(
      (cleanupError: unknown) => {
        deps.logger.warn(
          {
            err: cleanupError,
            generationId: generation?.id,
            jobId: job.id,
          },
          'Failed to schedule artifact generation cleanup',
        );
      },
    );
    const abortReason: unknown = controller.signal.reason;

    if (abortReason instanceof VideoTranscodeRunnerShutdownError) {
      await requeueJobForShutdown(deps, job);
      return;
    }

    if (
      error instanceof VideoTranscodeOwnershipLostError ||
      abortReason instanceof VideoTranscodeOwnershipLostError
    ) {
      return;
    }

    await updateJobAfterFailure(
      deps,
      job,
      error,
      error instanceof VideoTranscodeSourceNotCurrentError || isTerminalVideoTranscodeError(error),
    ).catch((updateError: unknown) => {
      if (!(updateError instanceof VideoTranscodeOwnershipLostError)) {
        throw updateError;
      }
    });
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }

    await Promise.allSettled(pendingHeartbeats);

    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, jobId: job.id, temporaryDirectory },
          'Failed to remove video transcode temporary directory',
        );
      });
    }
  }
};

type VideoTranscodeRunner = {
  start(): void;
  stop(): Promise<void>;
};

export const createVideoTranscodeRunner = (
  deps: VideoTranscodeRunnerDependencies,
): VideoTranscodeRunner => {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollPromise: Promise<void> | null = null;
  let stopping = false;
  const activeJobs = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<void>;
    }
  >();

  const runPoll = async (): Promise<void> => {
    if (
      stopping ||
      getAvailableVideoTranscodeSlots(deps.config.maxConcurrentJobs, activeJobs.size) === 0
    ) {
      return;
    }

    try {
      while (
        !stopping &&
        getAvailableVideoTranscodeSlots(deps.config.maxConcurrentJobs, activeJobs.size) > 0
      ) {
        const job = await claimNextVideoTranscodeJob(deps);

        if (!job) {
          break;
        }

        if (stopping) {
          await requeueJobForShutdown(deps, job);
          break;
        }

        const controller = new AbortController();
        const promise = processClaimedJob(deps, job, controller)
          .catch((error: unknown) => {
            deps.logger.error(
              { err: error, jobId: job.id },
              'Video transcode execution failed unexpectedly',
            );
          })
          .finally(() => {
            activeJobs.delete(job.id);

            if (!stopping) {
              void poll();
            }
          });
        activeJobs.set(job.id, { controller, promise });
      }
    } catch (error) {
      deps.logger.error({ err: error }, 'Video transcode polling failed');
    }
  };

  const poll = (): Promise<void> => {
    if (pollPromise) {
      return pollPromise;
    }

    const currentPoll = runPoll().finally(() => {
      if (pollPromise === currentPoll) {
        pollPromise = null;
      }
    });
    pollPromise = currentPoll;
    return currentPoll;
  };

  return {
    start() {
      if (pollTimer || stopping || deps.config.maxConcurrentJobs === 0) {
        return;
      }

      void poll();
      pollTimer = setInterval(() => {
        void poll();
      }, TRANSCODE_POLL_INTERVAL_MS);
      pollTimer.unref?.();
      deps.logger.info(
        {
          maxConcurrentJobs: deps.config.maxConcurrentJobs,
          threadsPerJob: deps.config.threadsPerJob,
        },
        'Video transcode runner started',
      );
    },

    async stop() {
      stopping = true;

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      await pollPromise;

      for (const { controller } of activeJobs.values()) {
        controller.abort(new VideoTranscodeRunnerShutdownError());
      }

      await Promise.allSettled([...activeJobs.values()].map(({ promise }) => promise));
      deps.logger.info({}, 'Video transcode runner stopped');
    },
  };
};
