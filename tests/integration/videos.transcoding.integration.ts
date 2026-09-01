import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildVideoArtifactManifest } from '../../src/services/videos/videoObjectKeys.js';
import {
  claimNextVideoTranscodeJob,
  createVideoTranscodeRunner,
  publishVideoArtifactGeneration,
  VideoTranscodeOwnershipLostError,
  type ClaimedVideoTranscodeJob,
} from '../../src/services/videos/videoTranscodeRunner.js';
import {
  createTranscodeTestVideo,
  createVerifiedSession,
  readStoredObject,
  uploadVideoSource,
} from './support/fixtures.js';
import { waitForTranscodeJob } from './support/videoArtifacts.js';
import { VIDEO_OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  createIntegrationApp,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';
import { throwCollectedErrors, waitForBarrier } from './support/asyncBarriers.js';

const createPublicationCommitBarrierPrisma = (
  prisma: PrismaClient,
  {
    afterGenerationActivation,
    afterPublicationCommit,
  }: {
    afterGenerationActivation: () => Promise<void>;
    afterPublicationCommit: () => Promise<void>;
  },
): PrismaClient =>
  new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ): Promise<T> => {
          let activatedGeneration = false;
          const result = await target.$transaction(async (tx) => {
            const observedTransaction = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === 'videoArtifactGeneration') {
                  return new Proxy(transactionTarget.videoArtifactGeneration, {
                    get(generationTarget, generationProperty) {
                      if (generationProperty === 'updateMany') {
                        return async (
                          args: Parameters<typeof generationTarget.updateMany>[0],
                        ): Promise<Awaited<ReturnType<typeof generationTarget.updateMany>>> => {
                          const updateResult = await generationTarget.updateMany(args);

                          if (
                            updateResult.count === 1 &&
                            typeof args.data === 'object' &&
                            args.data !== null &&
                            'state' in args.data &&
                            args.data.state === 'active'
                          ) {
                            activatedGeneration = true;
                            await afterGenerationActivation();
                          }

                          return updateResult;
                        };
                      }

                      const value = Reflect.get(
                        generationTarget,
                        generationProperty,
                        generationTarget,
                      ) as unknown;

                      return typeof value === 'function' ? value.bind(generationTarget) : value;
                    },
                  });
                }

                const value = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                  transactionTarget,
                ) as unknown;

                return typeof value === 'function' ? value.bind(transactionTarget) : value;
              },
            });

            return run(observedTransaction);
          }, options);

          if (activatedGeneration) {
            await afterPublicationCommit();
          }

          return result;
        };
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const readTranscodePublicationSnapshot = (
  prisma: PrismaClient,
  {
    jobId,
    videoId,
  }: {
    jobId: string;
    videoId: string;
  },
) =>
  prisma.$transaction(
    async (tx) => {
      const video = await tx.video.findUniqueOrThrow({
        where: { id: videoId },
        select: {
          activeArtifactGenerationId: true,
          durationSeconds: true,
          height: true,
          hlsMasterObjectKey: true,
          processingStatus: true,
          thumbnailObjectKey: true,
          width: true,
        },
      });
      const generations = await tx.videoArtifactGeneration.findMany({
        where: { videoId },
        select: {
          hlsMasterObjectKey: true,
          id: true,
          renditions: {
            orderBy: { quality: 'asc' },
            select: {
              bitrate: true,
              height: true,
              playlistObjectKey: true,
              quality: true,
              segmentPrefix: true,
              width: true,
            },
          },
          state: true,
          thumbnailObjectKey: true,
        },
      });
      const artifactTargets = await tx.externalResourceTarget.findMany({
        where: {
          videoId,
          role: { in: ['hls_artifacts', 'thumbnail_prefix'] },
        },
        select: {
          generation: true,
          goal: true,
          quiescenceNotBefore: true,
          role: true,
          state: true,
        },
      });
      const job = await tx.videoTranscodeJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { status: true },
      });

      return { artifactTargets, generations, job, video };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

describe('videos transcoding integration', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('transcodes an intermediate 280p source into a 240p-only HLS generation and serves it', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-240p@example.com',
      username: 'transcode_240p',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Intermediate source for 240p',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo({ width: 498, height: 280 }),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const runnerErrors: object[] = [];
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (data) => {
          runnerErrors.push(data);
        },
      },
    });

    runner.start();

    try {
      await expect(waitForTranscodeJob(runtime.prisma, job.id)).resolves.toMatchObject({
        status: 'completed',
        lastError: null,
      });
    } finally {
      await runner.stop();
    }

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          moderationStatus: true,
          processingStatus: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'pending',
      processingStatus: 'ready',
      visibility: 'unlisted',
    });

    const activeGeneration = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        state: 'active',
      },
      include: {
        renditions: true,
      },
    });
    expect(activeGeneration.renditions).toEqual([
      expect.objectContaining({
        quality: 'p240',
        width: 426,
        height: 240,
        bitrate: 700_000,
      }),
    ]);
    if (!activeGeneration.hlsMasterObjectKey) {
      throw new Error('Active 240p generation has no master playlist object key');
    }
    const masterPlaylist = await readStoredObject(
      runtime.videoObjectStorage,
      VIDEO_OBJECT_STORAGE_BUCKET,
      activeGeneration.hlsMasterObjectKey,
    );
    expect(masterPlaylist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=426x240');
    expect(masterPlaylist).toContain('240p/index.m3u8');
    expect(masterPlaylist).not.toContain('480p/index.m3u8');

    const app = await createIntegrationApp(runtime);
    const renditionPath = `/videos/${created.video.publicId}/hls/${activeGeneration.id}/240p/index.m3u8`;
    await request(app)
      .get(`/videos/${created.video.publicId}/hls/master.m3u8`)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(renditionPath);
        expect(response.text).not.toContain('/480p/index.m3u8');
      });
    await request(app)
      .get(renditionPath)
      .expect(200)
      .expect((response) => {
        expect(response.text).toMatch(
          new RegExp(`${renditionPath.replace('/index.m3u8', '')}/segments/segment-\\d+\\.ts`, 'u'),
        );
      });
    expect(runnerErrors).toEqual([]);
  });

  test('fails a source below 240p permanently on its first transcode attempt', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-too-small@example.com',
      username: 'transcode_too_small',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Permanently unsupported source',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo({ width: 426, height: 238 }),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: { id: true, maxAttempts: true },
    });
    expect(job.maxAttempts).toBeGreaterThan(1);

    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    runner.start();

    try {
      await expect(waitForTranscodeJob(runtime.prisma, job.id)).resolves.toMatchObject({
        status: 'failed',
        lastError: expect.stringContaining('below the minimum supported height of 240px'),
      });
    } finally {
      await runner.stop();
    }

    await expect(
      runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
        where: { id: job.id },
        select: {
          attempts: true,
          failedAt: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      attempts: 1,
      failedAt: expect.any(Date),
      status: 'failed',
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          processingStatus: true,
          transcodeError: true,
        },
      }),
    ).resolves.toEqual({
      processingStatus: 'failed',
      transcodeError: expect.stringContaining('below the minimum supported height of 240px'),
    });
    await expect(
      claimNextVideoTranscodeJob({
        prisma: runtime.prisma,
        clock: { now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
      }),
    ).resolves.toBeNull();
  });

  test('takes over a stale transcode into a complete generation, uses the ffmpeg thumbnail fallback, and retires the previous generation atomically', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-takeover@example.com',
      username: 'transcode_takeover',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Stale transcode takeover',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo(),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
        maxAttempts: true,
      },
    });
    const previousGenerationId = randomUUID();
    const previousManifest = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      previousGenerationId,
      [
        {
          quality: '480p',
          width: 640,
          height: 480,
          bandwidth: 1_400_000,
        },
      ],
    );
    await runtime.prisma.videoArtifactGeneration.create({
      data: {
        id: previousGenerationId,
        videoId: created.video.id,
        sourceUploadSessionId: source.uploadSession.id,
        transcodeJobId: job.id,
        executionId: randomUUID(),
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        state: 'active',
        hlsMasterObjectKey: previousManifest.master.objectKey,
        thumbnailObjectKey: previousManifest.thumbnail.objectKey,
        activatedAt: new Date(),
      },
    });
    await runtime.prisma.externalResourceTarget.createMany({
      data: [
        {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: previousManifest.hlsPrefix,
          selectorKind: 'prefix',
          role: 'hls_artifacts',
          generation: previousGenerationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'confirmed_present',
        },
        {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: previousManifest.thumbnailPrefix,
          selectorKind: 'prefix',
          role: 'thumbnail_prefix',
          generation: previousGenerationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'confirmed_present',
        },
      ],
    });
    await runtime.prisma.video.update({
      where: { id: created.video.id },
      data: {
        activeArtifactGenerationId: previousGenerationId,
        hlsMasterObjectKey: previousManifest.master.objectKey,
        thumbnailObjectKey: previousManifest.thumbnail.objectKey,
        processingStatus: 'ready',
        durationSeconds: 2,
      },
    });

    const abandonedExecutionId = randomUUID();
    await runtime.prisma.videoTranscodeJob.update({
      where: { id: job.id },
      data: {
        status: 'processing',
        attempts: 1,
        executionId: abandonedExecutionId,
        heartbeatAt: new Date(Date.now() - 60_000),
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const runnerErrors: object[] = [];
    const publicationPendingCommit = Promise.withResolvers<void>();
    const releasePublicationTransaction = Promise.withResolvers<void>();
    const publicationCommitted = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    const runnerLifecycle = Promise.withResolvers<void>();
    const snapshotPrisma = createPrismaClient(runtime.databaseUrl);
    const observedPrisma = createPublicationCommitBarrierPrisma(runtime.prisma, {
      afterGenerationActivation: async () => {
        publicationPendingCommit.resolve();
        await releasePublicationTransaction.promise;
      },
      afterPublicationCommit: async () => {
        publicationCommitted.resolve();
        await releasePublication.promise;
      },
    });
    const runner = createVideoTranscodeRunner({
      prisma: observedPrisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (data) => {
          runnerErrors.push(data);
          runnerLifecycle.reject(
            new Error('Transcode runner failed before the publication barrier'),
          );
        },
      },
    });

    runner.start();
    let completedJob: Awaited<ReturnType<typeof waitForTranscodeJob>>;

    try {
      await waitForBarrier({
        description: 'the uncommitted transcode publication writes',
        operations: [runnerLifecycle.promise],
        signal: publicationPendingCommit.promise,
        timeoutMs: 30_000,
      });
      const pendingSnapshot = await readTranscodePublicationSnapshot(snapshotPrisma, {
        jobId: job.id,
        videoId: created.video.id,
      });
      expect(pendingSnapshot.generations).toHaveLength(2);
      expect(pendingSnapshot.artifactTargets).toHaveLength(4);
      const pendingGeneration = pendingSnapshot.generations.find(
        ({ id }) => id !== previousGenerationId,
      );

      if (!pendingGeneration) {
        throw new Error('Pending transcode generation was not persisted');
      }

      const pendingManifest = buildVideoArtifactManifest(
        owner.userId,
        created.video.id,
        pendingGeneration.id,
        [],
      );
      const pendingCurrentTargets = pendingSnapshot.artifactTargets.filter(
        ({ generation }) => generation === pendingGeneration.id,
      );
      const pendingPreviousTargets = pendingSnapshot.artifactTargets.filter(
        ({ generation }) => generation === previousGenerationId,
      );

      expect(pendingSnapshot.video).toEqual({
        activeArtifactGenerationId: previousGenerationId,
        durationSeconds: 2,
        height: null,
        hlsMasterObjectKey: previousManifest.master.objectKey,
        processingStatus: 'ready',
        thumbnailObjectKey: previousManifest.thumbnail.objectKey,
        width: null,
      });
      expect(pendingSnapshot.generations).toContainEqual({
        hlsMasterObjectKey: previousManifest.master.objectKey,
        id: previousGenerationId,
        renditions: [],
        state: 'active',
        thumbnailObjectKey: previousManifest.thumbnail.objectKey,
      });
      expect(pendingGeneration).toEqual({
        hlsMasterObjectKey: pendingManifest.master.objectKey,
        id: pendingGeneration.id,
        renditions: [],
        state: 'writing',
        thumbnailObjectKey: pendingManifest.thumbnail.objectKey,
      });
      expect(pendingCurrentTargets).toHaveLength(2);
      expect(pendingCurrentTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            goal: 'present',
            quiescenceNotBefore: null,
            role: 'hls_artifacts',
            state: 'writing',
          }),
          expect.objectContaining({
            goal: 'present',
            quiescenceNotBefore: null,
            role: 'thumbnail_prefix',
            state: 'writing',
          }),
        ]),
      );
      expect(pendingPreviousTargets).toHaveLength(2);
      expect(pendingPreviousTargets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            goal: 'present',
            quiescenceNotBefore: null,
            role: 'hls_artifacts',
            state: 'confirmed_present',
          }),
          expect.objectContaining({
            goal: 'present',
            quiescenceNotBefore: null,
            role: 'thumbnail_prefix',
            state: 'confirmed_present',
          }),
        ]),
      );
      expect(pendingSnapshot.job).toEqual({ status: 'processing' });

      releasePublicationTransaction.resolve();
      await waitForBarrier({
        description: 'the committed transcode publication',
        operations: [runnerLifecycle.promise],
        signal: publicationCommitted.promise,
        timeoutMs: 30_000,
      });
      const committedSnapshot = await readTranscodePublicationSnapshot(snapshotPrisma, {
        jobId: job.id,
        videoId: created.video.id,
      });
      const committedGeneration = committedSnapshot.generations.find(
        ({ id }) => id !== previousGenerationId,
      );

      if (!committedGeneration) {
        throw new Error('Committed transcode generation was not persisted');
      }

      const summarizeTargets = (generation: string) =>
        committedSnapshot.artifactTargets
          .filter((target) => target.generation === generation)
          .map(({ goal, role, state }) => ({ goal, role, state }))
          .sort((left, right) => left.role.localeCompare(right.role));

      expect({
        activeGenerationId: committedSnapshot.video.activeArtifactGenerationId,
        activeGenerationState: committedGeneration.state,
        currentTargets: summarizeTargets(committedGeneration.id),
        jobStatus: committedSnapshot.job.status,
        previousGenerationState: committedSnapshot.generations.find(
          ({ id }) => id === previousGenerationId,
        )?.state,
        previousTargets: summarizeTargets(previousGenerationId),
      }).toEqual({
        activeGenerationId: committedGeneration.id,
        activeGenerationState: 'active',
        currentTargets: [
          { goal: 'present', role: 'hls_artifacts', state: 'confirmed_present' },
          { goal: 'present', role: 'thumbnail_prefix', state: 'confirmed_present' },
        ],
        jobStatus: 'completed',
        previousGenerationState: 'retiring',
        previousTargets: [
          { goal: 'absent', role: 'hls_artifacts', state: 'quiescing' },
          { goal: 'absent', role: 'thumbnail_prefix', state: 'quiescing' },
        ],
      });
      releasePublication.resolve();
      completedJob = await waitForTranscodeJob(runtime.prisma, job.id);
    } finally {
      releasePublicationTransaction.resolve();
      releasePublication.resolve();
      try {
        await runner.stop();
      } finally {
        runnerLifecycle.resolve();
        await snapshotPrisma.$disconnect();
      }
    }

    expect(completedJob).toMatchObject({
      status: 'completed',
      lastError: null,
      executionId: expect.any(String),
    });
    expect(completedJob.executionId).not.toBe(abandonedExecutionId);
    expect(runnerErrors).toEqual([]);
    const completedExecutionId = completedJob.executionId;

    if (!completedExecutionId) {
      throw new Error('Completed transcode job did not retain its execution id');
    }

    const [video, activeGeneration, previousGeneration, previousTargets] = await Promise.all([
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          activeArtifactGenerationId: true,
          durationSeconds: true,
          height: true,
          hlsMasterObjectKey: true,
          processingStatus: true,
          thumbnailObjectKey: true,
          width: true,
        },
      }),
      runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
        where: {
          videoId: created.video.id,
          executionId: completedExecutionId,
          state: 'active',
        },
        include: {
          renditions: {
            orderBy: { quality: 'asc' },
          },
        },
      }),
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: previousGenerationId },
        select: { state: true },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          videoId: created.video.id,
          generation: previousGenerationId,
        },
        select: {
          goal: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
    ]);

    expect(video).toMatchObject({
      activeArtifactGenerationId: activeGeneration.id,
      durationSeconds: 2,
      height: 480,
      hlsMasterObjectKey: activeGeneration.hlsMasterObjectKey,
      processingStatus: 'ready',
      thumbnailObjectKey: activeGeneration.thumbnailObjectKey,
      width: 640,
    });
    expect(activeGeneration.renditions).toHaveLength(1);
    expect(activeGeneration.renditions[0]).toMatchObject({
      quality: 'p480',
      width: 640,
      height: 480,
      bitrate: 1_400_000,
    });
    expect(previousGeneration.state).toBe('retiring');
    expect(previousTargets).toHaveLength(2);
    expect(
      previousTargets.every(
        (target) =>
          target.goal === 'absent' &&
          target.state === 'quiescing' &&
          target.quiescenceNotBefore !== null,
      ),
    ).toBe(true);

    const activeManifest = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      activeGeneration.id,
      [
        {
          quality: '480p',
          width: 640,
          height: 480,
          bandwidth: 1_400_000,
        },
      ],
    );
    const hlsObjects = await runtime.videoObjectStorage.listObjects({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      prefix: activeManifest.hlsPrefix,
      limit: 20,
    });
    const activeRendition = activeManifest.renditions[0];

    if (!activeRendition) {
      throw new Error('Expected a 480p rendition manifest');
    }

    expect(hlsObjects.truncated).toBe(false);
    expect(hlsObjects.objects.map(({ objectKey }) => objectKey)).toEqual(
      expect.arrayContaining([
        activeManifest.master.objectKey,
        activeRendition.playlistObjectKey,
        expect.stringMatching(
          new RegExp(`^${activeRendition.segmentPrefix.replaceAll('/', '\\/')}segment-\\d+\\.ts$`),
        ),
      ]),
    );
    const [masterPlaylist, renditionPlaylist] = await Promise.all([
      readStoredObject(
        runtime.videoObjectStorage,
        VIDEO_OBJECT_STORAGE_BUCKET,
        activeManifest.master.objectKey,
      ),
      readStoredObject(
        runtime.videoObjectStorage,
        VIDEO_OBJECT_STORAGE_BUCKET,
        activeRendition.playlistObjectKey,
      ),
    ]);
    expect(masterPlaylist).toContain('480p/index.m3u8');
    expect(renditionPlaylist).toMatch(/segments\/segment-\d+\.ts/u);
    expect(renditionPlaylist).not.toContain('\\');
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        objectKey: activeManifest.thumbnail.objectKey,
      }),
    ).resolves.toMatchObject({
      objectKey: activeManifest.thumbnail.objectKey,
    });

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.updateMany({
      where: {
        videoId: created.video.id,
        generation: previousGenerationId,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 2,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: previousGenerationId },
        select: {
          retiredAt: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      retiredAt: expect.any(Date),
      state: 'retired',
    });
  });

  test('prevents an abandoned transcode execution from publishing after takeover', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-fence@example.com',
      username: 'transcode_fence',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Execution fence',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source used only for the publication fence'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const storedJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
    });
    const abandonedExecutionId = randomUUID();
    const generationId = randomUUID();
    const manifest = buildVideoArtifactManifest(owner.userId, created.video.id, generationId, [
      {
        quality: '480p',
        width: 640,
        height: 480,
        bandwidth: 1_400_000,
      },
    ]);
    await runtime.prisma.videoTranscodeJob.update({
      where: { id: storedJob.id },
      data: {
        status: 'processing',
        attempts: 1,
        executionId: abandonedExecutionId,
        heartbeatAt: new Date(Date.now() - 60_000),
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    await runtime.prisma.videoArtifactGeneration.create({
      data: {
        id: generationId,
        videoId: created.video.id,
        sourceUploadSessionId: source.uploadSession.id,
        transcodeJobId: storedJob.id,
        executionId: abandonedExecutionId,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        state: 'writing',
        hlsMasterObjectKey: manifest.master.objectKey,
        thumbnailObjectKey: manifest.thumbnail.objectKey,
      },
    });
    await runtime.prisma.externalResourceTarget.createMany({
      data: [
        {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: manifest.hlsPrefix,
          selectorKind: 'prefix',
          role: 'hls_artifacts',
          generation: generationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'writing',
        },
        {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: manifest.thumbnailPrefix,
          selectorKind: 'prefix',
          role: 'thumbnail_prefix',
          generation: generationId,
          expectedSizeBytes: null,
          mayHaveMultipartUpload: false,
          goal: 'present',
          state: 'writing',
        },
      ],
    });

    const takeoverExecutionId = randomUUID();
    const takeoverAt = new Date();
    const claimed = await claimNextVideoTranscodeJob({
      prisma: runtime.prisma,
      clock: { now: () => takeoverAt },
      executionIdGenerator: {
        generate: () => takeoverExecutionId,
      },
    });
    expect(claimed).toMatchObject({
      id: storedJob.id,
      executionId: takeoverExecutionId,
      attempts: 2,
    });

    const abandonedJob: ClaimedVideoTranscodeJob = {
      id: storedJob.id,
      videoId: created.video.id,
      sourceObjectKey: source.uploadSession.objectKey,
      attempts: 1,
      maxAttempts: storedJob.maxAttempts,
      executionId: abandonedExecutionId,
    };
    await expect(
      publishVideoArtifactGeneration(
        {
          prisma: runtime.prisma,
          clock: { now: () => new Date() },
        },
        {
          generation: {
            id: generationId,
            sourceUploadSessionId: source.uploadSession.id,
            userId: owner.userId,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          },
          job: abandonedJob,
          manifest,
          probe: {
            width: 640,
            height: 480,
            durationSeconds: 2,
            hasAudio: true,
          },
        },
      ),
    ).rejects.toBeInstanceOf(VideoTranscodeOwnershipLostError);

    await expect(
      runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
        where: { id: storedJob.id },
        select: {
          executionId: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      executionId: takeoverExecutionId,
      status: 'processing',
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'writing' });
    await expect(
      runtime.prisma.videoRendition.count({
        where: { artifactGenerationId: generationId },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: { activeArtifactGenerationId: true },
      }),
    ).resolves.toEqual({ activeArtifactGenerationId: null });
  });

  test('stops polling, drains an owned slot, and requeues work without reserving artifacts', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-shutdown@example.com',
      username: 'transcode_shutdown',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Graceful transcode shutdown',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('shutdown source'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const downloadStarted = Promise.withResolvers<void>();
    const releaseDownload = Promise.withResolvers<void>();
    const runnerFailed = Promise.withResolvers<void>();
    const runnerErrors: object[] = [];
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: {
        ...runtime.videoObjectStorage,
        downloadObject: async () => {
          downloadStarted.resolve();
          await releaseDownload.promise;
        },
      },
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (data) => {
          runnerErrors.push(data);
          runnerFailed.reject(new Error('Transcode runner failed before graceful shutdown'));
        },
      },
    });

    runner.start();
    let stopped: Promise<void> | null = null;
    const coordinationErrors = new Set<unknown>();

    try {
      await waitForBarrier({
        description: 'the graceful-shutdown source download',
        operations: [runnerFailed.promise],
        signal: downloadStarted.promise,
        timeoutMs: 30_000,
      });
      stopped = runner.stop();
      releaseDownload.resolve();
      await stopped;
    } catch (error) {
      coordinationErrors.add(error);
    } finally {
      releaseDownload.resolve();
      runnerFailed.resolve();

      try {
        stopped ??= runner.stop();
      } catch (error) {
        coordinationErrors.add(error);
      }

      if (stopped) {
        const [stopResult] = await Promise.allSettled([stopped]);

        if (stopResult?.status === 'rejected') {
          coordinationErrors.add(stopResult.reason);
        }
      }
    }

    throwCollectedErrors(
      [...coordinationErrors],
      'Graceful transcode shutdown coordination failed',
    );

    await expect(
      runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
        where: { id: job.id },
        select: {
          attempts: true,
          executionId: true,
          heartbeatAt: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      attempts: 0,
      executionId: null,
      heartbeatAt: null,
      status: 'queued',
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.count({
        where: { videoId: created.video.id },
      }),
    ).resolves.toBe(0);
    expect(runnerErrors).toEqual([]);
  });
});
