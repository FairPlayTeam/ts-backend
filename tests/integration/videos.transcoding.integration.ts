import { randomUUID } from 'node:crypto';
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
import { resetState, startRuntime, stopRuntime, type TestRuntime } from './support/runtime.js';

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
      visibility: 'unlisted',
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
    let completedJob: Awaited<ReturnType<typeof waitForTranscodeJob>>;

    try {
      completedJob = await waitForTranscodeJob(runtime.prisma, job.id);
    } finally {
      await runner.stop();
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
      visibility: 'unlisted',
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
      visibility: 'unlisted',
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
        },
      },
    });

    runner.start();
    await downloadStarted.promise;
    const stopped = runner.stop();
    releaseDownload.resolve();
    await stopped;

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
