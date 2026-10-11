import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { HOUR_MS } from '../../config/constants.js';
import { runSerializableTransaction } from '../../lib/prismaTransactions.js';
import {
  requestExternalResourceAbsence,
  type ExternalResourceReconciliationHandler,
} from '../../services/externalResources.js';
import {
  buildVideoArtifactManifest,
  type VideoArtifactManifest,
} from '../../services/videos/videoObjectKeys.js';
import {
  createVideoHlsGenerationToken,
  toVideoRenditionQuality,
} from '../../services/videos/videoHls.js';
import type { VideoTranscodingDependencies, VideoTranscodingPrisma } from './dependencies.js';
import {
  VideoTranscodeOwnershipLostError,
  VideoTranscodeSourceNotCurrentError,
  type ClaimedVideoTranscodeJob,
  type GeneratedVideoArtifacts,
  type ReservedArtifactGeneration,
  type VideoProbe,
} from './types.js';
import { TRANSCODE_HEARTBEAT_STALE_MS } from './jobs.js';
import type { findCompletedSource } from './jobs.js';

const ABANDONED_GENERATION_MAINTENANCE_BATCH_SIZE = 50;
const VIDEO_ARTIFACT_RESOURCE_ROLES = ['hls_artifacts', 'thumbnail_prefix'] as const;

export const reserveArtifactGeneration = async (
  deps: Pick<
    VideoTranscodingDependencies,
    'clock' | 'generationIdGenerator' | 'objectStorage' | 'prisma'
  >,
  job: ClaimedVideoTranscodeJob,
  source: Awaited<ReturnType<typeof findCompletedSource>>,
): Promise<ReservedArtifactGeneration> => {
  const generationId = deps.generationIdGenerator?.generate() ?? randomUUID();
  const generationPublicToken = createVideoHlsGenerationToken();
  const manifest = buildVideoArtifactManifest(generationPublicToken, []);
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
        publicToken: generationPublicToken,
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
    publicToken: generationPublicToken,
    sourceUploadSessionId: source.id,
    userId: source.userId,
    bucket: deps.objectStorage.bucket,
  };
};

export const publishVideoArtifactGeneration = async (
  deps: Pick<VideoTranscodingDependencies, 'clock' | 'prisma'>,
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

export const scheduleArtifactGenerationCleanup = async (
  deps: {
    prisma: Pick<VideoTranscodingPrisma, '$transaction'>;
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
    prisma: Pick<VideoTranscodingPrisma, '$queryRaw' | '$transaction'>;
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

export const createVideoArtifactReconciliationHandlers = (clock: { now(): Date }) => {
  const artifactHandler = createVideoArtifactReconciliationHandler(clock);

  return {
    hls_artifacts: artifactHandler,
    thumbnail_prefix: artifactHandler,
  };
};

export const uploadAndVerifyArtifacts = async (
  deps: Pick<VideoTranscodingDependencies, 'objectStorage'>,
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
