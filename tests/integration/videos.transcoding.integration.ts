import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildVideoArtifactManifest } from '../../src/services/videos/videoObjectKeys.js';
import {
  probeVideo,
  transcodeVideoArtifacts,
  type VideoTranscodeLimits,
} from '../../src/services/videos/videoTranscode.js';
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
  decodeFirstVideoFrame,
  probeVideoArtifact,
  readStoredObject,
  readStoredObjectBuffer,
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
  VIDEO_TRANSCODE_TEST_CONFIG,
} from './support/runtime.js';
import { throwCollectedErrors, waitForBarrier } from './support/asyncBarriers.js';

type DirectFfmpegLimits = Pick<
  VideoTranscodeLimits,
  'ffmpegTimeoutMs' | 'maxArtifactBytes' | 'maxDurationSeconds' | 'maxFps' | 'maxPixels'
>;

const transcodeWithRealFfmpeg = ({
  inputPath,
  limits = {},
  outputDirectory,
}: {
  inputPath: string;
  limits?: Partial<DirectFfmpegLimits>;
  outputDirectory: string;
}) =>
  transcodeVideoArtifacts({
    inputPath,
    limits: {
      ffmpegTimeoutMs: VIDEO_TRANSCODE_TEST_CONFIG.ffmpegTimeoutMs,
      maxArtifactBytes: VIDEO_TRANSCODE_TEST_CONFIG.maxArtifactBytes,
      maxDurationSeconds: VIDEO_TRANSCODE_TEST_CONFIG.maxDurationSeconds,
      maxFps: VIDEO_TRANSCODE_TEST_CONFIG.maxFps,
      maxPixels: VIDEO_TRANSCODE_TEST_CONFIG.maxPixels,
      ...limits,
    },
    manifest: buildVideoArtifactManifest(
      'direct-transcode-user',
      'direct-transcode-video',
      'direct-transcode-generation',
      [
        {
          quality: '240p',
          width: 320,
          height: 240,
          videoBitrate: 700_000,
        },
      ],
    ),
    outputDirectory,
    probe: {
      width: 320,
      height: 240,
      durationSeconds: 2,
      displayWidth: 320,
      displayHeight: 240,
      hasAudio: true,
    },
    signal: new AbortController().signal,
    threads: 1,
  });

const redBlueDominanceAt = (
  frame: Awaited<ReturnType<typeof decodeFirstVideoFrame>>,
  xRatio: number,
  yRatio: number,
): number => {
  if (frame.channels < 3) {
    throw new Error('Decoded video frame does not expose RGB channels');
  }

  const x = Math.min(frame.width - 1, Math.floor(frame.width * xRatio));
  const y = Math.min(frame.height - 1, Math.floor(frame.height * yRatio));
  const offset = (y * frame.width + x) * frame.channels;
  const red = frame.data[offset];
  const blue = frame.data[offset + 2];

  if (red === undefined || blue === undefined) {
    throw new Error('Decoded video frame is missing an expected RGB pixel');
  }

  return red - blue;
};

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

const expectNoPublishedOrStoredArtifacts = async (
  runtime: TestRuntime,
  {
    userId,
    videoId,
  }: {
    userId: string;
    videoId: string;
  },
): Promise<void> => {
  const [video, generations] = await Promise.all([
    runtime.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: {
        activeArtifactGenerationId: true,
        hlsMasterObjectKey: true,
        thumbnailObjectKey: true,
      },
    }),
    runtime.prisma.videoArtifactGeneration.findMany({
      where: { videoId },
      select: { id: true, state: true },
    }),
  ]);

  expect(video).toEqual({
    activeArtifactGenerationId: null,
    hlsMasterObjectKey: null,
    thumbnailObjectKey: null,
  });
  expect(generations).toHaveLength(1);
  expect(generations.every(({ state }) => state !== 'active')).toBe(true);

  for (const generation of generations) {
    const manifest = buildVideoArtifactManifest(userId, videoId, generation.id, []);
    const [hlsObjects, thumbnailObjects] = await Promise.all([
      runtime.videoObjectStorage.listObjects({
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        prefix: manifest.hlsPrefix,
        limit: 1,
      }),
      runtime.videoObjectStorage.listObjects({
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        prefix: manifest.thumbnailPrefix,
        limit: 1,
      }),
    ]);

    expect(hlsObjects.objects).toEqual([]);
    expect(thumbnailObjects.objects).toEqual([]);
  }
};

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

  test('enforces decoder pixel and MP4 demuxer allowlists with real ffprobe', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-probe-limits-'));
    const inputPath = resolve(directory, 'source.mp4');

    try {
      await writeFile(inputPath, await createTranscodeTestVideo());
      await expect(
        probeVideo({
          inputPath,
          limits: {
            ...VIDEO_TRANSCODE_TEST_CONFIG,
            maxPixels: 1,
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('max pixel count');

      await writeFile(
        inputPath,
        await createTranscodeTestVideo({
          container: 'matroska',
        }),
      );
      await expect(
        probeVideo({
          inputPath,
          limits: VIDEO_TRANSCODE_TEST_CONFIG,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('not on whitelist');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('enforces decoder pixel, demuxer, and protocol allowlists with real ffmpeg when probing is bypassed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-ffmpeg-limits-'));
    const mp4Path = resolve(directory, 'source.mp4');
    const matroskaPath = resolve(directory, 'source.mkv');

    try {
      await writeFile(mp4Path, await createTranscodeTestVideo());
      await expect(
        transcodeWithRealFfmpeg({
          inputPath: mp4Path,
          limits: { maxPixels: 1 },
          outputDirectory: resolve(directory, 'pixels-output'),
        }),
      ).rejects.toThrow('max pixel count');

      await writeFile(
        matroskaPath,
        await createTranscodeTestVideo({
          container: 'matroska',
        }),
      );
      await expect(
        transcodeWithRealFfmpeg({
          inputPath: matroskaPath,
          outputDirectory: resolve(directory, 'demuxer-output'),
        }),
      ).rejects.toThrow('not on whitelist');

      await expect(
        transcodeWithRealFfmpeg({
          inputPath: 'http://127.0.0.1:9/source.mp4',
          outputDirectory: resolve(directory, 'protocol-output'),
        }),
      ).rejects.toThrow("Protocol 'http' not on whitelist 'file'");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('caps the frame rate and duration of real ffmpeg artifacts when probing is bypassed', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-ffmpeg-output-'));
    const inputPath = resolve(directory, 'source.mp4');

    try {
      await writeFile(
        inputPath,
        await createTranscodeTestVideo({
          durationSeconds: 2,
          frameRate: 120,
          height: 240,
          width: 320,
        }),
      );
      const artifacts = await transcodeWithRealFfmpeg({
        inputPath,
        limits: {
          maxDurationSeconds: 1,
          maxFps: 12,
        },
        outputDirectory: resolve(directory, 'output'),
      });
      const renditionSegments = artifacts.renditionSegments[0];

      if (!renditionSegments || renditionSegments.length === 0) {
        throw new Error('FFmpeg generated no segment for bounded-output inspection');
      }

      const artifactProbes = await Promise.all(
        renditionSegments.map(async (segment) =>
          probeVideoArtifact(await readFile(segment.filePath)),
        ),
      );

      for (const artifactProbe of artifactProbes) {
        expect(artifactProbe).toMatchObject({
          frameRate: 12,
          height: 240,
          sampleAspectRatio: '1:1',
          width: 320,
        });
      }

      expect(
        artifactProbes.reduce((total, artifactProbe) => total + artifactProbe.durationSeconds, 0),
      ).toBeLessThanOrEqual(1.25);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('transcodes a rotated anamorphic source into a square-pixel portrait HLS generation and serves it', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-rotated@example.com',
      username: 'transcode_rotated',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rotated anamorphic source',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo({
        width: 498,
        height: 280,
        sampleAspectRatio: '4/3',
        displayRotation: 90,
        visualPattern: 'vertical-halves',
      }),
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
        ...VIDEO_TRANSCODE_TEST_CONFIG,
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
        quality: 'p480',
        width: 202,
        height: 480,
        bitrate: 1_400_000,
      }),
    ]);
    const activeRendition = activeGeneration.renditions[0];

    if (!activeRendition) {
      throw new Error('Active portrait generation has no rendition');
    }

    const storedSegments = await runtime.videoObjectStorage.listObjects({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      prefix: activeRendition.segmentPrefix,
      limit: 1,
    });
    const storedSegment = storedSegments.objects[0];

    if (!storedSegment) {
      throw new Error('Active portrait generation has no stored segment');
    }

    const segmentBody = await readStoredObjectBuffer(
      runtime.videoObjectStorage,
      VIDEO_OBJECT_STORAGE_BUCKET,
      storedSegment.objectKey,
    );
    await expect(probeVideoArtifact(segmentBody)).resolves.toMatchObject({
      height: 480,
      sampleAspectRatio: '1:1',
      width: 202,
    });
    const frame = await decodeFirstVideoFrame(segmentBody);
    const topLeftDominance = redBlueDominanceAt(frame, 0.25, 0.25);
    const topRightDominance = redBlueDominanceAt(frame, 0.75, 0.25);
    const bottomLeftDominance = redBlueDominanceAt(frame, 0.25, 0.75);
    const bottomRightDominance = redBlueDominanceAt(frame, 0.75, 0.75);

    expect(Math.abs(topLeftDominance)).toBeGreaterThan(80);
    expect(Math.abs(topRightDominance)).toBeGreaterThan(80);
    expect(Math.abs(bottomLeftDominance)).toBeGreaterThan(80);
    expect(Math.abs(bottomRightDominance)).toBeGreaterThan(80);
    expect(topLeftDominance * topRightDominance).toBeGreaterThan(0);
    expect(bottomLeftDominance * bottomRightDominance).toBeGreaterThan(0);
    expect(topLeftDominance * bottomLeftDominance).toBeLessThan(0);

    if (!activeGeneration.hlsMasterObjectKey) {
      throw new Error('Active portrait generation has no master playlist object key');
    }
    const masterPlaylist = await readStoredObject(
      runtime.videoObjectStorage,
      VIDEO_OBJECT_STORAGE_BUCKET,
      activeGeneration.hlsMasterObjectKey,
    );
    expect(masterPlaylist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1680800,RESOLUTION=202x480');
    expect(masterPlaylist).toContain('480p/index.m3u8');
    expect(masterPlaylist).not.toContain('720p/index.m3u8');

    const app = await createIntegrationApp(runtime);
    const renditionPath = `/videos/${created.video.publicId}/hls/${activeGeneration.id}/480p/index.m3u8`;
    await request(app)
      .get(`/videos/${created.video.publicId}/hls/master.m3u8`)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(renditionPath);
        expect(response.text).not.toContain('/720p/index.m3u8');
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
        ...VIDEO_TRANSCODE_TEST_CONFIG,
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

  test('rejects an overlong source permanently before uploading or publishing artifacts', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-too-long@example.com',
      username: 'transcode_too_long',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Source over the configured duration limit',
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
      select: { id: true, maxAttempts: true },
    });
    expect(job.maxAttempts).toBeGreaterThan(1);

    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        ...VIDEO_TRANSCODE_TEST_CONFIG,
        maxConcurrentJobs: 1,
        maxDurationSeconds: 1,
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
        lastError: expect.stringContaining('duration 1.5s is above 1s'),
      });
    } finally {
      await runner.stop();
    }

    await expect(
      runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { attempts: true, status: true },
      }),
    ).resolves.toEqual({ attempts: 1, status: 'failed' });
    await expectNoPublishedOrStoredArtifacts(runtime, {
      userId: owner.userId,
      videoId: created.video.id,
    });
  });

  test('rejects oversized generated artifacts permanently before uploading or publishing them', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'transcode-artifacts-too-large@example.com',
      username: 'transcode_cap',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Artifacts over the configured size limit',
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
      select: { id: true, maxAttempts: true },
    });
    expect(job.maxAttempts).toBeGreaterThan(1);

    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        ...VIDEO_TRANSCODE_TEST_CONFIG,
        maxArtifactBytes: 1,
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
        lastError: expect.stringContaining('Generated video artifacts exceed the 1-byte limit'),
      });
    } finally {
      await runner.stop();
    }

    await expect(
      runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { attempts: true, status: true },
      }),
    ).resolves.toEqual({ attempts: 1, status: 'failed' });
    await expectNoPublishedOrStoredArtifacts(runtime, {
      userId: owner.userId,
      videoId: created.video.id,
    });
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
          videoBitrate: 1_400_000,
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
        ...VIDEO_TRANSCODE_TEST_CONFIG,
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
          videoBitrate: 1_400_000,
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
        videoBitrate: 1_400_000,
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
            displayWidth: 640,
            displayHeight: 480,
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
        ...VIDEO_TRANSCODE_TEST_CONFIG,
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
