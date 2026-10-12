import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildVideoArtifactManifest } from '../videos/shared/objectKeys.js';
import {
  isTerminalVideoTranscodeError,
  probeVideo,
  selectVideoTranscodeProfiles,
  transcodeVideoArtifacts,
} from './media.js';
import {
  publishVideoArtifactGeneration,
  reserveArtifactGeneration,
  scheduleArtifactGenerationCleanup,
  uploadAndVerifyArtifacts,
} from './artifacts.js';
import {
  assertCurrentSourceAndOwnership,
  claimNextVideoTranscodeJob,
  findCompletedSource,
  getAvailableVideoTranscodeSlots,
  requeueJobForShutdown,
  renewJobHeartbeat,
  updateJobAfterFailure,
} from './jobs.js';
import type { VideoTranscodingDependencies } from './dependencies.js';
import {
  VideoTranscodeOwnershipLostError,
  VideoTranscodeRunnerShutdownError,
  VideoTranscodeSourceNotCurrentError,
  type ClaimedVideoTranscodeJob,
  type ReservedArtifactGeneration,
} from './types.js';

const TRANSCODE_POLL_INTERVAL_MS = 2_000;
const TRANSCODE_HEARTBEAT_INTERVAL_MS = 10_000;

const processClaimedJob = async (
  deps: VideoTranscodingDependencies,
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
    const manifest = buildVideoArtifactManifest(generation.publicToken, profiles);
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
  deps: VideoTranscodingDependencies,
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
