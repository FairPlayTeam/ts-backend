import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import bcrypt from 'bcryptjs';
import {
  Prisma,
  PrismaClient,
  type VideoArtifactGenerationState,
  type VideoRenditionQuality,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { createApp } from '../../src/app.js';
import { createAdminService } from '../../src/services/admin.service.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { createProfilesService } from '../../src/services/profiles.service.js';
import { createUserMediaProcessor } from '../../src/services/userMedia/userMedia.processor.js';
import { createVideosService } from '../../src/services/videos.service.js';
import { createVideoPublicId } from '../../src/services/videos/videoPublicId.js';
import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  videoOriginalKey,
  type VideoObjectKeyQuality,
} from '../../src/services/videos/videoObjectKeys.js';
import {
  claimNextVideoTranscodeJob,
  createVideoTranscodeRunner,
  publishVideoArtifactGeneration,
  VideoTranscodeOwnershipLostError,
  type ClaimedVideoTranscodeJob,
} from '../../src/services/videos/videoTranscodeRunner.js';
import {
  generateSixDigitCode,
  generateToken,
  hashAuthCode,
  hashToken,
} from '../../src/lib/crypto.js';
import {
  createMinioClient,
  createMinioSigningClient,
  createObjectStorage,
  ObjectStorageUnavailableError,
  type ObjectStorage,
} from '../../src/lib/objectStorage.js';
import {
  createExternalResourceReconciler,
  type ExternalResourceReconciler,
} from '../../src/services/externalResources.js';
import {
  createMaintenanceCleanupJob,
  createRedisMaintenanceCleanupLock,
} from '../../src/maintenance/cleanup.js';
import { closeRedisClient, connectRedisClient, createRedisClient } from '../../src/lib/redis.js';
import {
  AUTH_RATE_LIMIT_MESSAGE,
  LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE,
  REGISTRATION_IDENTIFIER_RATE_LIMIT_MESSAGE,
} from '../../src/middleware/limiters.js';
import { INVALID_AUTH_SESSION_MESSAGE } from '../../src/middleware/auth.js';
import {
  LOGIN_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../../src/services/auth/auth.messages.js';
import {
  EMAIL_NOT_VERIFIED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
} from '../../src/services/auth.errors.js';
import { SELF_FOLLOW_MESSAGE } from '../../src/services/profiles.errors.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoUploadSessionNotFoundError,
  VideoUploadSizeMismatchError,
} from '../../src/services/videos.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  HOUR_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  REGISTRATION_IDENTIFIER_RATE_LIMIT_MAX,
  SESSION_TTL_MS,
} from '../../src/config/constants.js';
import type { AuthPorts } from '../../src/services/auth.types.js';
import type { AdminPorts } from '../../src/services/admin.types.js';
import type { ProfilesPorts } from '../../src/services/profiles.types.js';
import type { VideosPorts, VideosService } from '../../src/services/videos.types.js';
import type { Redis } from 'ioredis';
import type { ObjectStorageConfig } from '../../src/config/env.parsers.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

const POSTGRES_PORT = 5432;
const REDIS_PORT = 6379;
const MINIO_PORT = 9000;
const OBJECT_STORAGE_BUCKET = 'fairplay-integration-media';
const VIDEO_OBJECT_STORAGE_BUCKET = 'fairplay-integration-videos';
const OBJECT_STORAGE_ACCESS_KEY = 'fairplay';
const OBJECT_STORAGE_SECRET_KEY = 'fairplay-minio-secret';
const PROFILE_MEDIA_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const TEST_EMAIL = 'integration@example.com';
const TEST_USERNAME = 'integration_user';
const INITIAL_PASSWORD = 'Password1!';
const NEXT_PASSWORD = 'NewPassword1!';
const AUTH_CODE_PEPPER = 'integration-auth-code-pepper-change-me';

type DeliveredEmail = {
  email: string;
  token: string;
};

type DeliveredBanEmail = {
  email: string;
  reason: string;
};

type TestRuntime = {
  databaseUrl: string;
  redisUrl: string;
  objectStorageConfig: ObjectStorageConfig;
  postgresContainer: StartedTestContainer;
  redisContainer: StartedTestContainer;
  minioContainer: StartedTestContainer;
  prisma: PrismaClient;
  redisClient: Redis;
  objectStorage: ObjectStorage;
  videoObjectStorage: ObjectStorage;
  externalResources: ExternalResourceReconciler;
  adminService: AdminPorts;
  authService: AuthPorts;
  profilesService: ProfilesPorts;
  videosService: VideosService;
  delivered: {
    verification: DeliveredEmail[];
    passwordReset: DeliveredEmail[];
    accountBan: DeliveredBanEmail[];
  };
};

const testLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const runPrismaMigrations = async (databaseUrl: string): Promise<void> => {
  await execFileAsync('bun', ['x', 'prisma', 'migrate', 'deploy'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    timeout: 120_000,
  });
};

const runPostgresContainerCommand = async (
  container: StartedTestContainer,
  command: readonly string[],
): Promise<string> => {
  const result = await container.exec([...command]);

  if (result.exitCode !== 0) {
    throw new Error(`PostgreSQL container command failed: ${result.output}`);
  }

  return result.output;
};

const runPostgresSql = async (
  container: StartedTestContainer,
  database: string,
  sql: string,
): Promise<string> =>
  runPostgresContainerCommand(container, [
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'user',
    '-d',
    database,
    '-c',
    sql,
  ]);

const buildDatabaseUrl = (container: StartedTestContainer): string => {
  const host = container.getHost();
  const port = container.getMappedPort(POSTGRES_PORT);

  return `postgresql://user:password@${host}:${port}/fairplay?schema=public`;
};

const buildRedisUrl = (container: StartedTestContainer): string => {
  const host = container.getHost();
  const port = container.getMappedPort(REDIS_PORT);

  return `redis://${host}:${port}`;
};

const buildObjectStorageConfig = (
  container: StartedTestContainer,
  bucket = OBJECT_STORAGE_BUCKET,
): ObjectStorageConfig => {
  const origin = `http://${container.getHost()}:${container.getMappedPort(MINIO_PORT)}`;
  const publicOrigin = new URL(origin);

  if (publicOrigin.hostname === 'localhost') {
    publicOrigin.hostname = '127.0.0.1';
  } else if (publicOrigin.hostname === '127.0.0.1') {
    publicOrigin.hostname = 'localhost';
  }

  return {
    endpoint: origin,
    publicUrl: publicOrigin.origin,
    region: 'us-east-1',
    bucket,
    accessKey: OBJECT_STORAGE_ACCESS_KEY,
    secretKey: OBJECT_STORAGE_SECRET_KEY,
    signedUrlTtlSeconds: 900,
    operationTimeoutMs: 10_000,
  };
};

const createPng = async (width = 800, height = 600): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#3388ff',
    },
  })
    .png()
    .toBuffer();

const createTranscodeTestVideo = async (): Promise<Buffer> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-video-'));
  const outputPath = resolve(directory, 'source.mp4');

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x480:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000',
        '-t',
        '1.5',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { timeout: 30_000 },
    );

    return await readFile(outputPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const readStoredObject = async (
  storage: ObjectStorage,
  bucket: string,
  objectKey: string,
): Promise<string> => (await readStoredObjectBuffer(storage, bucket, objectKey)).toString('utf8');

const readStoredObjectBuffer = async (
  storage: ObjectStorage,
  bucket: string,
  objectKey: string,
): Promise<Buffer> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-object-'));
  const destinationPath = resolve(directory, 'object');

  try {
    await storage.downloadObject({
      bucket,
      objectKey,
      destinationPath,
    });

    return await readFile(destinationPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

const createIntegrationAuthService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  delivered: TestRuntime['delivered'],
  externalResources: ExternalResourceReconciler,
  {
    afterPasswordCompare,
  }: {
    afterPasswordCompare?: () => Promise<void>;
  } = {},
): AuthPorts =>
  createAuthService({
    prisma,
    isUniqueError: (err): boolean =>
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    hasher: {
      hash: (password, rounds) => bcrypt.hash(password, rounds),
      compare: async (password, hash) => {
        const matches = await bcrypt.compare(password, hash);
        await afterPasswordCompare?.();

        return matches;
      },
    },
    token: {
      generate: () => generateToken(),
      generateSixDigitCode: () => generateSixDigitCode(),
      hashAuthCode: (secret) => hashAuthCode(secret, AUTH_CODE_PEPPER),
      hashOpaqueToken: (token) => hashToken(token),
    },
    mailer: {
      sendVerificationEmail: async (email, code) => {
        delivered.verification.push({ email, token: code });
      },
      sendPasswordResetEmail: async (email, code) => {
        delivered.passwordReset.push({ email, token: code });
      },
    },
    objectStorage,
    externalResources,
    userMediaProcessor: createUserMediaProcessor({
      profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    }),
    clock: {
      now: () => new Date(),
    },
    config: {
      bcryptRounds: 4,
      emailVerificationTokenTtlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
      passwordResetTokenTtlMs: PASSWORD_RESET_TOKEN_TTL_MS,
      sessionTtlMs: SESSION_TTL_MS,
    },
    logger: {
      warn: () => undefined,
    },
  });

const createIntegrationAdminService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  delivered: TestRuntime['delivered'],
  now: () => Date = () => new Date(),
): AdminPorts =>
  createAdminService({
    prisma,
    objectStorage,
    mailer: {
      sendAccountBannedEmail: async (email, reason) => {
        delivered.accountBan.push({ email, reason });
      },
    },
    clock: {
      now,
    },
    logger: {
      warn: () => undefined,
    },
  });

const createIntegrationProfilesService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
): ProfilesPorts =>
  createProfilesService({
    prisma,
    objectStorage,
  });

const createIntegrationVideosService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  externalResources: ExternalResourceReconciler,
  config: {
    maxUploadBytes?: number;
    now?: () => Date;
    publicIds?: string[];
    userStorageQuotaBytes?: number;
  } = {},
): VideosService =>
  createVideosService({
    prisma,
    objectStorage,
    externalResources,
    imageProcessor: createUserMediaProcessor({
      profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    }),
    clock: {
      now: config.now ?? (() => new Date()),
    },
    publicIdGenerator: {
      generate: () => config.publicIds?.shift() ?? createVideoPublicId(),
    },
    logger: {
      warn: () => undefined,
    },
    config: {
      maxPartCount: 10_000,
      maxUploadBytes: config.maxUploadBytes ?? 3 * 1024 * 1024 * 1024,
      partSizeBytes: 67_108_864,
      sessionTtlSeconds: 86_400,
      userStorageQuotaBytes: config.userStorageQuotaBytes ?? 100 * 1024 * 1024 * 1024,
    },
  });

const createIntegrationApp = async (runtime: TestRuntime) =>
  createApp(
    {
      allowedOrigins: [],
      profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
      baseUrl: 'http://localhost:3000',
      isProduction: false,
      jsonBodyLimitBytes: 1024 * 1024,
      rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
      trustProxy: false,
    },
    {
      adminService: runtime.adminService,
      authService: runtime.authService,
      profilesService: runtime.profilesService,
      videosService: runtime.videosService,
      redisClient: runtime.redisClient,
      readinessChecks: {
        database: async () => {
          await runtime.prisma.$queryRaw`SELECT 1`;
        },
        redis: async () => {
          await runtime.redisClient.ping();
        },
        objectStorage: async () => {
          await Promise.all([
            runtime.objectStorage.checkReady(),
            runtime.videoObjectStorage.checkReady(),
          ]);
        },
      },
    },
  );

const expectIntegrationReadinessOk = async (
  app: Awaited<ReturnType<typeof createIntegrationApp>>,
): Promise<void> => {
  await request(app)
    .get('/health/ready')
    .expect(200)
    .expect({
      status: 'ok',
      services: {
        database: 'ok',
        redis: 'ok',
        objectStorage: 'ok',
      },
    });
};

const startRuntime = async (): Promise<TestRuntime> => {
  let postgresContainer: StartedTestContainer | null = null;
  let redisContainer: StartedTestContainer | null = null;
  let minioContainer: StartedTestContainer | null = null;

  try {
    postgresContainer = await new GenericContainer('postgres:17-alpine')
      .withEnvironment({
        POSTGRES_USER: 'user',
        POSTGRES_PASSWORD: 'password',
        POSTGRES_DB: 'fairplay',
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
      .withStartupTimeout(120_000)
      .start();

    redisContainer = await new GenericContainer('redis:8-alpine')
      .withCommand(['redis-server', '--save', '', '--appendonly', 'no'])
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
      .withStartupTimeout(60_000)
      .start();

    minioContainer = await new GenericContainer('minio/minio:RELEASE.2025-09-07T16-13-09Z')
      .withEnvironment({
        MINIO_ROOT_USER: OBJECT_STORAGE_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: OBJECT_STORAGE_SECRET_KEY,
      })
      .withCommand(['server', '/data', '--console-address', ':9001'])
      .withExposedPorts(MINIO_PORT)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', MINIO_PORT).forStatusCode(200))
      .withStartupTimeout(60_000)
      .start();

    const databaseUrl = buildDatabaseUrl(postgresContainer);
    const redisUrl = buildRedisUrl(redisContainer);
    const objectStorageConfig = buildObjectStorageConfig(minioContainer);
    const videoObjectStorageConfig = buildObjectStorageConfig(
      minioContainer,
      VIDEO_OBJECT_STORAGE_BUCKET,
    );

    await runPrismaMigrations(databaseUrl);

    const prisma = createPrismaClient(databaseUrl);
    const redisClient = createRedisClient(redisUrl, testLogger);
    const objectStorage = createObjectStorage(
      objectStorageConfig,
      createMinioClient(objectStorageConfig),
      testLogger,
      createMinioSigningClient(objectStorageConfig),
    );
    const videoObjectStorage = createObjectStorage(
      videoObjectStorageConfig,
      createMinioClient(videoObjectStorageConfig),
      testLogger,
      createMinioSigningClient(videoObjectStorageConfig),
    );
    const externalResources = createExternalResourceReconciler({
      prisma,
      objectStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    await connectRedisClient(redisClient);

    const delivered = {
      verification: [] as DeliveredEmail[],
      passwordReset: [] as DeliveredEmail[],
      accountBan: [] as DeliveredBanEmail[],
    };

    return {
      databaseUrl,
      redisUrl,
      objectStorageConfig,
      postgresContainer,
      redisContainer,
      minioContainer,
      prisma,
      redisClient,
      objectStorage,
      videoObjectStorage,
      externalResources,
      adminService: createIntegrationAdminService(prisma, objectStorage, delivered),
      authService: createIntegrationAuthService(
        prisma,
        objectStorage,
        delivered,
        externalResources,
      ),
      profilesService: createIntegrationProfilesService(prisma, objectStorage),
      videosService: createIntegrationVideosService(prisma, videoObjectStorage, externalResources),
      delivered,
    };
  } catch (error) {
    await minioContainer?.stop();
    await redisContainer?.stop();
    await postgresContainer?.stop();
    throw error;
  }
};

const stopRuntime = async (runtime: TestRuntime | null): Promise<void> => {
  if (!runtime) {
    return;
  }

  await runtime.prisma.$disconnect();
  await closeRedisClient(runtime.redisClient, testLogger);
  await runtime.minioContainer.stop();
  await runtime.redisContainer.stop();
  await runtime.postgresContainer.stop();
};

const resetState = async (runtime: TestRuntime): Promise<void> => {
  await runtime.prisma.passwordResetToken.deleteMany();
  await runtime.prisma.emailVerificationToken.deleteMany();
  await runtime.prisma.session.deleteMany();
  await runtime.prisma.userFollow.deleteMany();
  await runtime.prisma.user.deleteMany();
  await runtime.prisma.externalResourceTarget.deleteMany();
  await runtime.redisClient.call('flushdb');
  runtime.delivered.verification = [];
  runtime.delivered.passwordReset = [];
  runtime.delivered.accountBan = [];
};

const createVerifiedSession = async (
  runtime: TestRuntime,
  {
    email,
    username,
  }: {
    email: string;
    username: string;
  },
): Promise<{ sessionKey: string; userId: string }> => {
  await runtime.authService.register({
    email,
    username,
    password: INITIAL_PASSWORD,
  });

  const verificationEmail = runtime.delivered.verification.at(-1);
  const result = await runtime.authService.verifyEmail({
    email,
    code: verificationEmail?.token ?? '',
  });

  return {
    sessionKey: result.sessionKey,
    userId: result.user.id,
  };
};

const uploadVideoSource = async (
  service: VideosPorts,
  {
    body,
    userId,
    videoId,
    thumbnails = [],
  }: {
    body: Buffer;
    userId: string;
    videoId: string;
    thumbnails?: readonly Buffer[];
  },
) => {
  const initialized = await service.initMultipartUpload({
    userId,
    videoId,
    sizeBytes: body.length,
  });
  const uploadId = initialized.uploadSession.uploadId;

  if (!uploadId) {
    throw new Error('Initialized multipart upload did not expose its upload id');
  }

  for (const thumbnail of thumbnails) {
    await service.uploadSourceThumbnail({
      userId,
      videoId,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });
  }

  const signed = await service.signMultipartUploadParts({
    userId,
    videoId,
    uploadSessionId: initialized.uploadSession.id,
    partNumbers: [1],
  });
  const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
    method: 'PUT',
    body,
  });

  expect(uploadResponse.status).toBe(200);
  const etag = uploadResponse.headers.get('etag');

  if (!etag) {
    throw new Error('Multipart source upload did not return an ETag');
  }

  return service.completeMultipartUpload({
    userId,
    videoId,
    uploadSessionId: initialized.uploadSession.id,
    parts: [{ partNumber: 1, etag }],
  });
};

const hlsProfileForQuality = (
  quality: VideoObjectKeyQuality,
): {
  persistedQuality: VideoRenditionQuality;
  width: number;
  height: number;
  bandwidth: number;
} => {
  switch (quality) {
    case '480p':
      return {
        persistedQuality: 'p480',
        width: 854,
        height: 480,
        bandwidth: 1_400_000,
      };
    case '720p':
      return {
        persistedQuality: 'p720',
        width: 1280,
        height: 720,
        bandwidth: 2_800_000,
      };
    case '1080p':
      return {
        persistedQuality: 'p1080',
        width: 1920,
        height: 1080,
        bandwidth: 5_000_000,
      };
  }
};

const seedHlsGeneration = async (
  runtime: TestRuntime,
  {
    segmentBody,
    sourceUploadSessionId,
    state,
    transcodeJobId,
    userId,
    videoId,
    quality = '480p',
  }: {
    segmentBody: Buffer;
    sourceUploadSessionId: string;
    state: VideoArtifactGenerationState;
    transcodeJobId: string;
    userId: string;
    videoId: string;
    quality?: VideoObjectKeyQuality;
  },
) => {
  const generationId = randomUUID();
  const profile = hlsProfileForQuality(quality);
  const manifest = buildVideoArtifactManifest(userId, videoId, generationId, [
    {
      quality,
      width: profile.width,
      height: profile.height,
      bandwidth: profile.bandwidth,
    },
  ]);
  const rendition = manifest.renditions[0];

  if (!rendition) {
    throw new Error('Expected a seeded HLS rendition');
  }

  await runtime.prisma.videoArtifactGeneration.create({
    data: {
      id: generationId,
      videoId,
      sourceUploadSessionId,
      transcodeJobId,
      executionId: randomUUID(),
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      state,
      hlsMasterObjectKey: manifest.master.objectKey,
      thumbnailObjectKey: manifest.thumbnail.objectKey,
      ...(state === 'active' || state === 'retiring' ? { activatedAt: new Date() } : {}),
      ...(state === 'retired' ? { retiredAt: new Date() } : {}),
    },
  });
  await runtime.prisma.videoRendition.create({
    data: {
      artifactGenerationId: generationId,
      quality: profile.persistedQuality,
      width: profile.width,
      height: profile.height,
      bitrate: profile.bandwidth,
      playlistObjectKey: rendition.playlistObjectKey,
      segmentPrefix: rendition.segmentPrefix,
      codec: 'h264',
      container: 'hls',
    },
  });

  const segmentName = 'segment-00000.ts';
  await Promise.all([
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.master.objectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:3\n' +
          `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.width}x${profile.height},CODECS="avc1.4d401f,mp4a.40.2"\n` +
          `${quality}/index.m3u8\n`,
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: rendition.playlistObjectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:6\n' +
          '#EXT-X-TARGETDURATION:6\n' +
          '#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXTINF:6.000000,\n' +
          `segments/${segmentName}\n` +
          '#EXT-X-ENDLIST\n',
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: videoHlsSegmentObjectKey(rendition, segmentName),
      body: segmentBody,
      contentType: 'video/mp2t',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.thumbnail.objectKey,
      body: Buffer.from('test thumbnail bytes'),
      contentType: 'image/webp',
    }),
  ]);

  return {
    generationId,
    manifest,
    quality,
    segmentBody,
    segmentName,
  };
};

const reserveHlsArtifactTargets = async (
  runtime: TestRuntime,
  {
    generationId,
    manifest,
    state,
    userId,
    videoId,
  }: {
    generationId: string;
    manifest: ReturnType<typeof buildVideoArtifactManifest>;
    state: 'writing' | 'confirmed_present';
    userId: string;
    videoId: string;
  },
): Promise<void> => {
  await runtime.prisma.externalResourceTarget.createMany({
    data: [
      {
        userId,
        videoId,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: manifest.hlsPrefix,
        selectorKind: 'prefix',
        role: 'hls_artifacts',
        generation: generationId,
        expectedSizeBytes: null,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state,
      },
      {
        userId,
        videoId,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: manifest.thumbnailPrefix,
        selectorKind: 'prefix',
        role: 'thumbnail_prefix',
        generation: generationId,
        expectedSizeBytes: null,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state,
      },
    ],
  });
};

const prepareHlsGenerationForPublication = async (
  runtime: TestRuntime,
  {
    job,
    quality = '480p',
    segmentBody,
    sourceUploadSessionId,
    userId,
    videoId,
  }: {
    job: ClaimedVideoTranscodeJob;
    quality?: VideoObjectKeyQuality;
    segmentBody: Buffer;
    sourceUploadSessionId: string;
    userId: string;
    videoId: string;
  },
) => {
  const generationId = randomUUID();
  const profile = hlsProfileForQuality(quality);
  const manifest = buildVideoArtifactManifest(userId, videoId, generationId, [
    {
      quality,
      width: profile.width,
      height: profile.height,
      bandwidth: profile.bandwidth,
    },
  ]);
  const rendition = manifest.renditions[0];

  if (!rendition) {
    throw new Error('Expected a publishable HLS rendition');
  }

  await runtime.prisma.videoArtifactGeneration.create({
    data: {
      id: generationId,
      videoId,
      sourceUploadSessionId,
      transcodeJobId: job.id,
      executionId: job.executionId,
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      state: 'writing',
    },
  });
  await reserveHlsArtifactTargets(runtime, {
    generationId,
    manifest,
    state: 'writing',
    userId,
    videoId,
  });

  const segmentName = 'segment-00000.ts';
  await Promise.all([
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.master.objectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:3\n' +
          `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.width}x${profile.height},CODECS="avc1.4d401f,mp4a.40.2"\n` +
          `${quality}/index.m3u8\n`,
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: rendition.playlistObjectKey,
      body: Buffer.from(
        '#EXTM3U\n' +
          '#EXT-X-VERSION:6\n' +
          '#EXT-X-TARGETDURATION:6\n' +
          '#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXTINF:6.000000,\n' +
          `segments/${segmentName}\n` +
          '#EXT-X-ENDLIST\n',
      ),
      contentType: 'application/vnd.apple.mpegurl',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: videoHlsSegmentObjectKey(rendition, segmentName),
      body: segmentBody,
      contentType: 'video/mp2t',
    }),
    runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: manifest.thumbnail.objectKey,
      body: Buffer.from('test thumbnail bytes'),
      contentType: 'image/webp',
    }),
  ]);

  return {
    generation: {
      id: generationId,
      sourceUploadSessionId,
      userId,
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
    },
    generationId,
    manifest,
    quality,
    segmentName,
  };
};

const waitForTranscodeJob = async (
  prisma: PrismaClient,
  jobId: string,
): Promise<{
  executionId: string | null;
  lastError: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
}> => {
  const deadline = Date.now() + 40_000;

  while (Date.now() < deadline) {
    const job = await prisma.videoTranscodeJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        executionId: true,
        lastError: true,
        status: true,
      },
    });

    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }

    await delay(200);
  }

  throw new Error('Timed out waiting for the transcode job to finish');
};

const createOneShotBarrier = (participants: number, timeoutMs = 10_000): (() => Promise<void>) => {
  const outcome = Promise.withResolvers<void>();
  let arrivals = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return async () => {
    if (arrivals >= participants) {
      return;
    }

    arrivals += 1;
    if (arrivals === 1) {
      timeout = setTimeout(() => {
        outcome.reject(new Error(`Barrier timed out waiting for ${participants} participants`));
      }, timeoutMs);
      timeout.unref?.();
    }
    if (arrivals === participants) {
      if (timeout) {
        clearTimeout(timeout);
      }
      outcome.resolve();
    }
    await outcome.promise;
  };
};

const waitForBlockedVideoQueries = async (
  prisma: PrismaClient,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [activity] = await prisma.$queryRaw<Array<{ blocked_count: number }>>`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "videos"%'
    `;

    if ((activity?.blocked_count ?? 0) >= expectedCount) {
      return;
    }

    await delay(25);
  }

  throw new Error(`Timed out waiting for ${expectedCount} blocked video queries`);
};

describe('auth integration', () => {
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

  test('migrates a populated pre-thumbnail upload session and keeps it usable', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const migrationName = '20260727120000_add_video_source_thumbnails';
    const databaseName = `thumbnail_migration_${randomUUID().replaceAll('-', '')}`;
    const userId = '11111111-1111-4111-8111-111111111111';
    const videoId = '22222222-2222-4222-8222-222222222222';
    const uploadSessionId = '33333333-3333-4333-8333-333333333333';
    const sourceTargetId = '44444444-4444-4444-8444-444444444444';
    let migrationPrisma: PrismaClient | null = null;
    let thumbnailObjectKey: string | null = null;

    await runPostgresContainerCommand(runtime.postgresContainer, [
      'createdb',
      '-U',
      'user',
      databaseName,
    ]);

    try {
      const migrationsDirectory = resolve(projectRoot, 'prisma', 'migrations');
      const migrationDirectories = (await readdir(migrationsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name < migrationName)
        .map((entry) => entry.name)
        .sort();

      for (const directory of migrationDirectories) {
        const sql = await readFile(
          resolve(migrationsDirectory, directory, 'migration.sql'),
          'utf8',
        );
        await runPostgresSql(runtime.postgresContainer, databaseName, sql);
      }

      await runPostgresSql(
        runtime.postgresContainer,
        databaseName,
        `
            INSERT INTO "users" (
              "id", "email", "username", "password_hash", "is_verified",
              "created_at", "updated_at"
            ) VALUES (
              '${userId}', 'preexisting-thumbnail@example.com', 'preexisting_thumb',
              'unused-password-hash', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "videos" (
              "id", "public_id", "owner_id", "title", "created_at", "updated_at"
            ) VALUES (
              '${videoId}', 'PreMigration1', '${userId}', 'Pre-migration video',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "external_resource_targets" (
              "id", "user_id", "video_id", "bucket", "selector", "selector_kind",
              "role", "generation", "expected_size_bytes", "may_have_multipart_upload",
              "goal", "state", "created_at", "updated_at"
            ) VALUES (
              '${sourceTargetId}', '${userId}', '${videoId}',
              '${VIDEO_OBJECT_STORAGE_BUCKET}',
              '${userId}/${videoId}/sources/${uploadSessionId}/original.mp4',
              'exact', 'source', '${uploadSessionId}', 1, true,
              'present', 'writing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            INSERT INTO "video_upload_sessions" (
              "id", "video_id", "user_id", "status", "bucket", "object_key",
              "part_size_bytes", "expected_size_bytes", "expires_at",
              "external_resource_target_id", "created_at", "updated_at"
            ) VALUES (
              '${uploadSessionId}', '${videoId}', '${userId}', 'initiated',
              '${VIDEO_OBJECT_STORAGE_BUCKET}',
              '${userId}/${videoId}/sources/${uploadSessionId}/original.mp4',
              67108864, 1, '2099-01-01T00:00:00.000Z',
              '${sourceTargetId}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
          `,
      );

      const thumbnailMigration = await readFile(
        resolve(migrationsDirectory, migrationName, 'migration.sql'),
        'utf8',
      );
      const enumStatementEnd = thumbnailMigration.indexOf(';') + 1;

      if (enumStatementEnd <= 0) {
        throw new Error('Thumbnail migration enum statement was not found');
      }

      await runPostgresSql(
        runtime.postgresContainer,
        databaseName,
        thumbnailMigration.slice(0, enumStatementEnd),
      );
      await runPostgresSql(
        runtime.postgresContainer,
        databaseName,
        thumbnailMigration.slice(enumStatementEnd),
      );

      const migratedDatabaseUrl = new URL(runtime.databaseUrl);
      migratedDatabaseUrl.pathname = `/${databaseName}`;
      migrationPrisma = createPrismaClient(migratedDatabaseUrl.toString());
      const migrationExternalResources = createExternalResourceReconciler({
        prisma: migrationPrisma,
        objectStorage: runtime.videoObjectStorage,
        clock: {
          now: () => new Date(),
        },
        logger: testLogger,
      });
      const migrationVideosService = createIntegrationVideosService(
        migrationPrisma,
        runtime.videoObjectStorage,
        migrationExternalResources,
      );
      const preexistingSession = await migrationPrisma.videoUploadSession.findUniqueOrThrow({
        where: {
          id: uploadSessionId,
        },
        include: {
          sourceThumbnail: true,
        },
      });

      expect(preexistingSession).toMatchObject({
        id: uploadSessionId,
        status: 'initiated',
        sourceThumbnail: null,
      });
      await expect(
        migrationVideosService.getMultipartUploadSession({
          userId,
          videoId,
          uploadSessionId,
        }),
      ).resolves.toMatchObject({
        uploadSession: {
          id: uploadSessionId,
          status: 'initiated',
        },
      });

      const thumbnail = await createPng(1600, 900);
      await expect(
        migrationVideosService.uploadSourceThumbnail({
          userId,
          videoId,
          uploadSessionId,
          file: {
            buffer: thumbnail,
            size: thumbnail.length,
          },
        }),
      ).resolves.toMatchObject({
        thumbnail: {
          uploadSessionId,
          width: 1280,
          height: 720,
        },
      });
      thumbnailObjectKey = (
        await migrationPrisma.videoSourceThumbnail.findUniqueOrThrow({
          where: {
            uploadSessionId,
          },
          select: {
            objectKey: true,
          },
        })
      ).objectKey;
    } finally {
      await migrationPrisma?.$disconnect();
      if (thumbnailObjectKey) {
        await runtime.videoObjectStorage.deleteObject(
          thumbnailObjectKey,
          VIDEO_OBJECT_STORAGE_BUCKET,
        );
      }
      await runPostgresContainerCommand(runtime.postgresContainer, [
        'dropdb',
        '--force',
        '-U',
        'user',
        databaseName,
      ]);
    }
  }, 120_000);

  test('runs the account lifecycle through HTTP, Prisma, and Redis', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);

    await request(app)
      .post('/auth/register')
      .send({
        email: ` ${TEST_EMAIL.toUpperCase()} `,
        username: ` ${TEST_USERNAME.toUpperCase()} `,
        password: INITIAL_PASSWORD,
      })
      .expect(201)
      .expect({
        message: REGISTER_SUCCESS_MESSAGE,
      });

    const verificationEmail = runtime.delivered.verification.at(-1);
    expect(verificationEmail).toEqual({
      email: TEST_EMAIL,
      token: expect.stringMatching(/^\d{6}$/),
    });

    const storedVerificationToken = await runtime.prisma.emailVerificationToken.findFirstOrThrow();
    expect(storedVerificationToken.token).not.toBe(verificationEmail?.token);
    expect(storedVerificationToken.token).toBe(
      hashAuthCode(
        `${storedVerificationToken.userId}:${verificationEmail?.token ?? ''}`,
        AUTH_CODE_PEPPER,
      ),
    );

    await request(app)
      .post('/auth/login')
      .send({
        emailOrUsername: TEST_EMAIL,
        password: INITIAL_PASSWORD,
      })
      .expect(403)
      .expect({
        error: 'Forbidden',
        message: EMAIL_NOT_VERIFIED_MESSAGE,
      });

    const verifyResponse = await request(app)
      .post('/auth/verify-email')
      .send({
        email: TEST_EMAIL,
        code: verificationEmail?.token,
      })
      .expect(200);

    expect(verifyResponse.body).toEqual({
      message: VERIFY_EMAIL_SUCCESS_MESSAGE,
      user: {
        id: expect.any(String),
        email: TEST_EMAIL,
        username: TEST_USERNAME,
        displayName: TEST_USERNAME,
        bio: null,
        role: 'user',
      },
      sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      session: {
        id: expect.any(String),
        expiresAt: expect.any(String),
      },
    });

    const firstSessionKey = verifyResponse.body.sessionKey as string;
    const persistedSession = await runtime.prisma.session.findFirstOrThrow();
    expect(persistedSession.sessionKey).toBe(hashToken(firstSessionKey));
    expect(persistedSession.sessionKeySuffix).toBe(firstSessionKey.slice(-8));

    await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${firstSessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.user.email).toBe(TEST_EMAIL);
        expect(response.body.session.id).toBe(verifyResponse.body.session.id);
      });

    await request(app)
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${firstSessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.sessions).toHaveLength(1);
        expect(response.body.sessions[0]).toEqual(
          expect.objectContaining({
            id: verifyResponse.body.session.id,
            isCurrent: true,
          }),
        );
      });

    await request(app)
      .post('/auth/forgot-password')
      .send({
        email: TEST_EMAIL,
      })
      .expect(200)
      .expect({
        message: RESET_PASSWORD_EMAIL_MESSAGE,
      });

    const resetEmail = runtime.delivered.passwordReset.at(-1);
    expect(resetEmail).toEqual({
      email: TEST_EMAIL,
      token: expect.stringMatching(/^\d{6}$/),
    });

    const storedPasswordResetToken = await runtime.prisma.passwordResetToken.findFirstOrThrow();
    expect(storedPasswordResetToken.token).not.toBe(resetEmail?.token);
    expect(storedPasswordResetToken.token).toBe(
      hashAuthCode(
        `${storedPasswordResetToken.userId}:${resetEmail?.token ?? ''}`,
        AUTH_CODE_PEPPER,
      ),
    );

    await request(app)
      .post('/auth/reset-password')
      .send({
        email: TEST_EMAIL,
        code: resetEmail?.token,
        password: NEXT_PASSWORD,
      })
      .expect(200)
      .expect({
        message: RESET_PASSWORD_SUCCESS_MESSAGE,
        sessionsLoggedOut: 1,
      });

    await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${firstSessionKey}`)
      .expect(401)
      .expect({
        error: 'Unauthorized',
        message: INVALID_AUTH_SESSION_MESSAGE,
      });

    await request(app)
      .post('/auth/login')
      .send({
        emailOrUsername: TEST_USERNAME,
        password: INITIAL_PASSWORD,
      })
      .expect(401)
      .expect({
        error: 'Unauthorized',
        message: INVALID_CREDENTIALS_MESSAGE,
      });

    const loginResponse = await request(app)
      .post('/auth/login')
      .send({
        emailOrUsername: TEST_USERNAME,
        password: NEXT_PASSWORD,
      })
      .expect(200);

    expect(loginResponse.body).toEqual(
      expect.objectContaining({
        message: LOGIN_SUCCESS_MESSAGE,
        sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  test('reports readiness against the real database, redis, and object storage clients', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);

    await expectIntegrationReadinessOk(app);
  });

  test('claims reconciliation targets with exclusive leases and persists retry backoff', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const owner = await createVerifiedSession(runtime, {
      email: 'reconciliation-lease@example.com',
      username: 'reconcile_lease',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Reconciliation lease',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const objectKey = `${owner.userId}/${created.video.id}/lease-test/object.bin`;
    const body = Buffer.from('lease-protected-object');
    await runtime.videoObjectStorage.putObject({
      objectKey,
      body,
      contentType: 'application/octet-stream',
    });
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: objectKey,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: BigInt(body.length),
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    let signalPrepared: (() => void) | undefined;
    let releasePreparation: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      signalPrepared = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const firstReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      leaseIdGenerator: {
        generate: () => '11111111-1111-4111-8111-111111111111',
      },
      logger: testLogger,
    });
    const secondReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      leaseIdGenerator: {
        generate: () => '22222222-2222-4222-8222-222222222222',
      },
      logger: testLogger,
    });
    const firstRun = firstReconciler.reconcileTarget({
      targetId: target.id,
      roles: ['source'],
      handlers: {
        source: {
          preparePresent: async () => {
            signalPrepared?.();
            await preparationReleased;
          },
        },
      },
    });

    await prepared;
    await expect(
      secondReconciler.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
      }),
    ).resolves.toBe('skipped');
    releasePreparation?.();
    await expect(firstRun).resolves.toBe('confirmed');

    const missingTarget = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: `${objectKey}.missing`,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: 10n,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    const failedAt = Date.now();
    await expect(
      runtime.externalResources.reconcileDue({
        roles: ['source'],
        limit: 1,
      }),
    ).resolves.toEqual({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 0,
      failed: 1,
    });
    const failedTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: { id: missingTarget.id },
    });

    expect(failedTarget).toMatchObject({
      state: 'writing',
      attempts: 1,
      lastError: 'Reserved external object is not present',
      reconciliationLeaseId: null,
      reconciliationLeaseExpiresAt: null,
    });
    expect(failedTarget.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(failedAt + 60_000);

    const longErrorTarget = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: `${objectKey}.long-error`,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: 10n,
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
      },
      select: { id: true },
    });
    const longError = new Error('x'.repeat(1_500));
    const failingReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: {
        ...runtime.videoObjectStorage,
        headObject: async () => {
          throw longError;
        },
      },
      clock: { now: () => new Date() },
      logger: testLogger,
    });

    await expect(
      failingReconciler.reconcileTarget({
        targetId: longErrorTarget.id,
        roles: ['source'],
      }),
    ).rejects.toBe(longError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: longErrorTarget.id },
        select: { attempts: true, lastError: true },
      }),
    ).resolves.toEqual({
      attempts: 1,
      lastError: 'x'.repeat(1_000),
    });
  });

  test('requires a new claim after a reconciliation lease expires', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'expired-reconciliation-lease@example.com',
      username: 'expired_lease',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Expired reconciliation lease',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const objectKey = `${owner.userId}/${created.video.id}/expired-lease.bin`;
    const body = Buffer.from('expired lease object');
    await runtime.videoObjectStorage.putObject({
      objectKey,
      body,
      contentType: 'application/octet-stream',
    });
    let observedAt = new Date();
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: created.video.id,
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        selector: objectKey,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: BigInt(body.length),
        mayHaveMultipartUpload: false,
        goal: 'present',
        state: 'writing',
        nextAttemptAt: observedAt,
      },
      select: { id: true },
    });
    const expiredOwner = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      leaseIdGenerator: {
        generate: () => '11111111-1111-4111-8111-111111111111',
      },
      logger: testLogger,
    });

    await expect(
      expiredOwner.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
        handlers: {
          source: {
            preparePresent: async () => {
              observedAt = new Date(observedAt.getTime() + 6 * 60 * 1000);
            },
          },
        },
      }),
    ).rejects.toThrow('External resource reconciliation lease was lost');
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          reconciliationLeaseId: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      reconciliationLeaseId: '11111111-1111-4111-8111-111111111111',
      state: 'reconciling',
    });

    const newOwner = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      leaseIdGenerator: {
        generate: () => '22222222-2222-4222-8222-222222222222',
      },
      logger: testLogger,
    });
    await expect(
      newOwner.reconcileTarget({
        targetId: target.id,
        roles: ['source'],
      }),
    ).resolves.toBe('confirmed');
  });

  test('retries public-id collisions and paginates owner videos on PostgreSQL', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-metadata@example.com',
      username: 'video_metadata',
    });
    const service = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      {
        publicIds: ['FixedId01_', 'FixedId01_', 'FixedId02_'],
      },
    );
    const createInput = {
      userId: owner.userId,
      description: null,
      tags: [],
      license: 'all_rights_reserved' as const,
      visibility: 'public' as const,
      allowComments: true,
    };
    const first = await service.createVideo({
      ...createInput,
      title: 'First video',
    });
    const second = await service.createVideo({
      ...createInput,
      title: 'Second video',
    });

    expect(first.video.publicId).toBe('FixedId01_');
    expect(first.video.visibility).toBe('unlisted');
    expect(second.video.publicId).toBe('FixedId02_');

    const firstPage = await service.listMyVideos({
      userId: owner.userId,
      limit: 1,
    });

    expect(firstPage.videos).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.listMyVideos({
      userId: owner.userId,
      limit: 1,
      ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
    });

    expect(secondPage.videos).toHaveLength(1);
    expect(secondPage.videos[0]?.id).not.toBe(firstPage.videos[0]?.id);
    expect(secondPage.total).toBe(2);
  });

  test('authorizes moderators and persists idempotent decisions with filtered cursor pagination', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    let moderationNow = new Date('2026-02-01T12:00:00.000Z');
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => moderationNow,
      ),
    });
    const owner = await createVerifiedSession(runtime, {
      email: 'moderation-owner@example.com',
      username: 'moderation_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'moderation-staff@example.com',
      username: 'moderation_staff',
    });
    const ordinaryUser = await createVerifiedSession(runtime, {
      email: 'moderation-user@example.com',
      username: 'moderation_user',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const createVideo = (title: string) =>
      activeRuntime.videosService.createVideo({
        userId: owner.userId,
        title,
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });
    const approved = await createVideo('Approve unlisted');

    await request(app)
      .get('/moderation/videos')
      .set('Authorization', `Bearer ${ordinaryUser.sessionKey}`)
      .expect(403);
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${ordinaryUser.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(403);
    await request(app)
      .post(`/moderation/videos/${randomUUID()}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(404)
      .expect({
        error: 'NotFound',
        message: 'Video not found',
      });

    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200)
      .expect((response) => {
        expect(response.body.video).toMatchObject({
          id: approved.video.id,
          moderationStatus: 'approved',
          visibility: 'public',
          publishedAt: moderationNow.toISOString(),
        });
      });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: moderationNow,
      rejectedAt: null,
      visibility: 'public',
    });

    moderationNow = new Date('2026-02-02T12:00:00.000Z');
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'rejected',
      publishedAt: new Date('2026-02-01T12:00:00.000Z'),
      rejectedAt: moderationNow,
      visibility: 'unlisted',
    });

    moderationNow = new Date('2026-02-03T12:00:00.000Z');
    await request(app)
      .post(`/moderation/videos/${approved.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200);
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approved.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: new Date('2026-02-01T12:00:00.000Z'),
      rejectedAt: null,
      visibility: 'public',
    });

    const rejected = await createVideo('Rejected list item');
    await request(app)
      .post(`/moderation/videos/${rejected.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);

    const pendingVideos = await Promise.all([
      createVideo('Pending oldest'),
      createVideo('Pending middle'),
      createVideo('Pending newest'),
    ]);

    const pendingDates = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
    ] as const;
    await Promise.all(
      pendingVideos.map((video, index) =>
        activeRuntime.prisma.video.update({
          where: { id: video.video.id },
          data: {
            createdAt: pendingDates[index] ?? pendingDates[0],
            processingStatus: 'ready',
          },
        }),
      ),
    );
    await runtime.prisma.video.update({
      where: { id: approved.video.id },
      data: { processingStatus: 'ready' },
    });
    await runtime.prisma.video.update({
      where: { id: rejected.video.id },
      data: { processingStatus: 'failed' },
    });

    const firstPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        sort: 'oldest',
        search: 'reserved and ignored',
        limit: 2,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(firstPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending oldest',
      'Pending middle',
    ]);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.nextCursor).toEqual({
      createdAt: pendingDates[1]?.toISOString(),
      id: pendingVideos[1]?.video.id,
    });

    const secondPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        sort: 'oldest',
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorId: firstPage.body.nextCursor.id,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(secondPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending newest',
    ]);
    expect(secondPage.body.nextCursor).toBeNull();

    const newestPage = await request(app)
      .get('/moderation/videos')
      .query({
        moderationStatus: 'pending',
        processingStatus: 'ready',
        limit: 3,
      })
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .expect(200);
    expect(newestPage.body.videos.map(({ title }: { title: string }) => title)).toEqual([
      'Pending newest',
      'Pending middle',
      'Pending oldest',
    ]);
  });

  test('keeps the first rejection timestamp and purges after its original seven-day window', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const rejectionStartedAt = new Date('2026-03-01T00:00:00.000Z');
    let moderationNow = rejectionStartedAt;
    const owner = await createVerifiedSession(runtime, {
      email: 're-rejection-owner@example.com',
      username: 're_rejection_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 're-rejection-moderator@example.com',
      username: 're_reject_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Original rejection deadline',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => moderationNow,
      ),
    });

    await request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);
    moderationNow = new Date(rejectionStartedAt.getTime() + 6 * 24 * HOUR_MS);
    await request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);

    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: video.video.id },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'rejected',
      publishedAt: null,
      rejectedAt: rejectionStartedAt,
      visibility: 'unlisted',
    });

    const observedAt = new Date(rejectionStartedAt.getTime() + 7 * 24 * HOUR_MS + 1);
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      { now: () => observedAt },
    );

    await expect(
      controlledVideosService.deleteExpiredRejectedVideos({
        observedAt,
        rejectedBefore: new Date(observedAt.getTime() - 7 * 24 * HOUR_MS),
      }),
    ).resolves.toEqual({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: video.video.id },
      }),
    ).resolves.toBeNull();
  });

  test('serializes opposing moderation decisions into one canonical final state', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const decisionAt = new Date('2026-03-10T00:00:00.000Z');
    const owner = await createVerifiedSession(runtime, {
      email: 'opposing-decisions-owner@example.com',
      username: 'opposing_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'opposing-decisions-moderator@example.com',
      username: 'opposing_moderator',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Opposing decisions',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => decisionAt,
      ),
    });
    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const gateAcquired = Promise.withResolvers<void>();
    const releaseGate = Promise.withResolvers<void>();
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "videos"
          WHERE "id" = CAST(${video.video.id} AS UUID)
          FOR UPDATE
        `;
        gateAcquired.resolve();
        await releaseGate.promise;
      },
      {
        timeout: 15_000,
      },
    );

    await Promise.race([
      gateAcquired.promise,
      delay(5_000).then(() => {
        throw new Error('Moderation decision gate could not be acquired');
      }),
    ]);
    const approvalPromise = request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'approved' })
      .expect(200)
      .then((response) => response);
    const rejectionPromise = request(app)
      .post(`/moderation/videos/${video.video.id}/moderation`)
      .set('Authorization', `Bearer ${moderator.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200)
      .then((response) => response);

    try {
      await waitForBlockedVideoQueries(runtime.prisma, 2);
    } finally {
      releaseGate.resolve();
      await gateTransaction;
      await gatePrisma.$disconnect();
    }

    const [approvalResponse, rejectionResponse] = await Promise.all([
      approvalPromise,
      rejectionPromise,
    ]);

    expect(approvalResponse.body.video).toMatchObject({
      moderationStatus: 'approved',
      publishedAt: decisionAt.toISOString(),
      rejectedAt: null,
      visibility: 'public',
    });
    expect(rejectionResponse.body.video).toMatchObject({
      moderationStatus: 'rejected',
      rejectedAt: decisionAt.toISOString(),
      visibility: 'unlisted',
    });
    const finalState = await runtime.prisma.video.findUniqueOrThrow({
      where: { id: video.video.id },
      select: {
        moderationStatus: true,
        publishedAt: true,
        rejectedAt: true,
        visibility: true,
      },
    });

    if (finalState.moderationStatus === 'approved') {
      expect(finalState).toEqual({
        moderationStatus: 'approved',
        publishedAt: decisionAt,
        rejectedAt: null,
        visibility: 'public',
      });
    } else {
      expect(finalState).toEqual({
        moderationStatus: 'rejected',
        publishedAt: decisionAt,
        rejectedAt: decisionAt,
        visibility: 'unlisted',
      });
    }
  });

  test('serializes maintenance and approval in both row-lock acquisition orders', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const cleanupNow = new Date('2026-03-20T00:00:00.000Z');
    const rejectedAt = new Date(cleanupNow.getTime() - 8 * 24 * HOUR_MS);
    const owner = await createVerifiedSession(runtime, {
      email: 'maintenance-approval-owner@example.com',
      username: 'maintenance_owner',
    });
    const moderator = await createVerifiedSession(runtime, {
      email: 'maintenance-approval-moderator@example.com',
      username: 'maintenance_mod',
    });
    await runtime.prisma.user.update({
      where: { id: moderator.userId },
      data: { role: 'moderator' },
    });
    const app = await createIntegrationApp({
      ...runtime,
      adminService: createIntegrationAdminService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        () => cleanupNow,
      ),
    });

    const runInterleaving = async (maintenanceFirst: boolean) => {
      const video = await runtime?.videosService.createVideo({
        userId: owner.userId,
        title: maintenanceFirst ? 'Maintenance wins row lock' : 'Approval wins row lock',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });

      if (!video || !runtime) {
        throw new Error('Integration runtime disappeared during moderation race setup');
      }

      await runtime.prisma.video.update({
        where: { id: video.video.id },
        data: {
          moderationStatus: 'rejected',
          rejectedAt,
        },
      });
      const maintenancePrisma = createPrismaClient(runtime.databaseUrl);
      const maintenanceExternalResources = createExternalResourceReconciler({
        prisma: maintenancePrisma,
        objectStorage: runtime.videoObjectStorage,
        clock: { now: () => cleanupNow },
        logger: testLogger,
      });
      const maintenanceVideosService = createIntegrationVideosService(
        maintenancePrisma,
        runtime.videoObjectStorage,
        maintenanceExternalResources,
        { now: () => cleanupNow },
      );
      const gatePrisma = createPrismaClient(runtime.databaseUrl);
      const gateAcquired = Promise.withResolvers<void>();
      const releaseGate = Promise.withResolvers<void>();
      const gateTransaction = gatePrisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "videos"
            WHERE "id" = CAST(${video.video.id} AS UUID)
            FOR UPDATE
          `;
          gateAcquired.resolve();
          await releaseGate.promise;
        },
        {
          timeout: 15_000,
        },
      );

      await Promise.race([
        gateAcquired.promise,
        delay(5_000).then(() => {
          throw new Error('Maintenance/approval gate could not be acquired');
        }),
      ]);
      const startApproval = () =>
        request(app)
          .post(`/moderation/videos/${video.video.id}/moderation`)
          .set('Authorization', `Bearer ${moderator.sessionKey}`)
          .send({ decision: 'approved' })
          .then((response) => response);
      const startMaintenance = () =>
        maintenanceVideosService.deleteExpiredRejectedVideos({
          observedAt: cleanupNow,
          rejectedBefore: new Date(cleanupNow.getTime() - 7 * 24 * HOUR_MS),
        });
      let approvalPromise: ReturnType<typeof startApproval>;
      let maintenancePromise: ReturnType<typeof startMaintenance>;

      try {
        if (maintenanceFirst) {
          maintenancePromise = startMaintenance();
          await waitForBlockedVideoQueries(runtime.prisma, 1);
          approvalPromise = startApproval();
        } else {
          approvalPromise = startApproval();
          await waitForBlockedVideoQueries(runtime.prisma, 1);
          maintenancePromise = startMaintenance();
        }

        await waitForBlockedVideoQueries(runtime.prisma, 2);
      } finally {
        releaseGate.resolve();
        await gateTransaction;
        await gatePrisma.$disconnect();
      }

      try {
        const [approvalResponse, maintenanceResult] = await Promise.all([
          approvalPromise,
          maintenancePromise,
        ]);

        return {
          approvalResponse,
          maintenanceResult,
          videoId: video.video.id,
        };
      } finally {
        await maintenancePrisma.$disconnect();
      }
    };

    const approvalWins = await runInterleaving(false);

    expect(approvalWins.approvalResponse.status).toBe(200);
    expect(approvalWins.maintenanceResult).toEqual({
      rejectedVideosDeleted: 0,
      rejectedVideoTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: approvalWins.videoId },
        select: {
          moderationStatus: true,
          publishedAt: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      publishedAt: cleanupNow,
      rejectedAt: null,
      visibility: 'public',
    });

    const maintenanceWins = await runInterleaving(true);

    expect(maintenanceWins.maintenanceResult).toEqual({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 0,
    });
    expect(maintenanceWins.approvalResponse.status).toBe(404);
    expect(maintenanceWins.approvalResponse.body).toEqual({
      error: 'NotFound',
      message: 'Video not found',
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: maintenanceWins.videoId },
      }),
    ).resolves.toBeNull();
  });

  test('purges only still-rejected videos after seven days and preserves absence targets', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'rejected-cleanup-owner@example.com',
      username: 'rejected_cleanup',
    });
    const rejectedAt = new Date();
    const observedAt = new Date(rejectedAt.getTime() + 8 * 24 * HOUR_MS);
    const purged = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected video to purge',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('rejected source bytes'),
      userId: owner.userId,
      videoId: purged.video.id,
      thumbnails: [await createPng(640, 360)],
    });
    const transcodeJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: purged.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const generation = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('rejected generation segment'),
      sourceUploadSessionId: source.uploadSession.id,
      state: 'active',
      transcodeJobId: transcodeJob.id,
      userId: owner.userId,
      videoId: purged.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generation.generationId,
      manifest: generation.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: purged.video.id,
    });
    await runtime.prisma.video.update({
      where: { id: purged.video.id },
      data: {
        activeArtifactGenerationId: generation.generationId,
        hlsMasterObjectKey: generation.manifest.master.objectKey,
        thumbnailObjectKey: generation.manifest.thumbnail.objectKey,
        moderationStatus: 'rejected',
        processingStatus: 'ready',
        rejectedAt,
      },
    });

    const reapproved = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Rejected then approved',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    await runtime.prisma.video.update({
      where: { id: reapproved.video.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt,
      },
    });
    await runtime.adminService.moderateVideo({
      videoId: reapproved.video.id,
      decision: 'approved',
    });

    let cleanupNow = observedAt;
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => cleanupNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      controlledExternalResources,
      { now: () => cleanupNow },
    );
    const cleanup = createMaintenanceCleanupJob({
      authService: runtime.authService,
      videosService: controlledVideosService,
      clock: { now: () => cleanupNow },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 30 * 24 * HOUR_MS,
      },
      logger: testLogger,
    });
    const cleanupResult = await cleanup.runOnce();

    expect(cleanupResult.failedSteps).toEqual([]);
    expect(cleanupResult.summary).toMatchObject({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 4,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: purged.video.id },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: reapproved.video.id },
        select: {
          moderationStatus: true,
          rejectedAt: true,
          visibility: true,
        },
      }),
    ).resolves.toEqual({
      moderationStatus: 'approved',
      rejectedAt: null,
      visibility: 'public',
    });
    const retainedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        videoId: purged.video.id,
      },
      select: {
        bucket: true,
        goal: true,
        role: true,
        selector: true,
        selectorKind: true,
        state: true,
      },
      orderBy: { role: 'asc' },
    });

    expect(retainedTargets).toHaveLength(4);
    expect(retainedTargets.map(({ role }) => role).sort()).toEqual([
      'hls_artifacts',
      'source',
      'source_thumbnail',
      'thumbnail_prefix',
    ]);
    expect(retainedTargets).toEqual(
      expect.arrayContaining([expect.objectContaining({ goal: 'absent', state: 'quiescing' })]),
    );
    expect(
      retainedTargets.every(({ goal, state }) => goal === 'absent' && state === 'quiescing'),
    ).toBe(true);
    await expect(
      runtime.prisma.videoUploadSession.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.videoTranscodeJob.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);
    await expect(
      runtime.prisma.videoArtifactGeneration.count({
        where: { videoId: purged.video.id },
      }),
    ).resolves.toBe(0);

    cleanupNow = new Date(observedAt.getTime() + HOUR_MS + 1);
    await expect(
      controlledExternalResources.reconcileDue({
        roles: ['source', 'source_thumbnail', 'hls_artifacts', 'thumbnail_prefix'],
        limit: 10,
      }),
    ).resolves.toEqual({
      claimed: 4,
      confirmed: 4,
      redirectedAbsent: 0,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          videoId: purged.video.id,
        },
        select: {
          state: true,
        },
      }),
    ).resolves.toEqual([
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
      { state: 'confirmed_absent' },
    ]);

    for (const target of retainedTargets) {
      if (target.selectorKind === 'exact') {
        await expect(
          runtime.videoObjectStorage.headObject({
            bucket: target.bucket,
            objectKey: target.selector,
          }),
        ).resolves.toBeNull();
      } else {
        await expect(
          runtime.videoObjectStorage.listObjects({
            bucket: target.bucket,
            prefix: target.selector,
            limit: 1,
          }),
        ).resolves.toMatchObject({
          objects: [],
        });
      }
    }
  });

  test('reconciles a reserved source thumbnail deleted with its video before PUT completion', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    let scenarioNow = new Date();
    const owner = await createVerifiedSession(runtime, {
      email: 'deleted-thumbnail-owner@example.com',
      username: 'deleted_thumb_owner',
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail reservation deleted before PUT',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: video.video.id,
      sizeBytes: 1,
    });
    await runtime.prisma.video.update({
      where: { id: video.video.id },
      data: {
        moderationStatus: 'rejected',
        rejectedAt: new Date(scenarioNow.getTime() - 8 * 24 * HOUR_MS),
      },
    });
    const putStarted = Promise.withResolvers<void>();
    const releasePut = Promise.withResolvers<void>();
    let writtenThumbnail:
      | {
          bucket: string;
          objectKey: string;
        }
      | undefined;
    const barrierStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        writtenThumbnail = {
          bucket: input.bucket ?? VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey: input.objectKey,
        };
        putStarted.resolve();
        await releasePut.promise;
        await activeRuntime.videoObjectStorage.putObject(input);
      },
    };
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: barrierStorage,
      clock: { now: () => scenarioNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      barrierStorage,
      controlledExternalResources,
      { now: () => scenarioNow },
    );
    const thumbnail = await createPng(900, 1200);
    const uploadPromise = controlledVideosService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: video.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });

    await Promise.race([
      putStarted.promise,
      delay(10_000).then(() => {
        throw new Error('Source thumbnail PUT barrier was not reached');
      }),
    ]);
    const reservedTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        generation: initialized.uploadSession.id,
        role: 'source_thumbnail',
      },
    });

    expect(reservedTarget).toMatchObject({
      goal: 'present',
      state: 'writing',
    });
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: { uploadSessionId: initialized.uploadSession.id },
      }),
    ).resolves.toBeNull();

    const rejectedBefore = new Date(scenarioNow.getTime() - 7 * 24 * HOUR_MS);
    await expect(
      controlledVideosService.deleteExpiredRejectedVideos({
        observedAt: scenarioNow,
        rejectedBefore,
      }),
    ).resolves.toEqual({
      rejectedVideosDeleted: 1,
      rejectedVideoTargetsScheduled: 0,
    });
    await expect(
      runtime.prisma.video.findUnique({
        where: { id: video.video.id },
      }),
    ).resolves.toBeNull();

    releasePut.resolve();
    await expect(uploadPromise).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: reservedTarget.id },
        select: {
          goal: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      quiescenceNotBefore: new Date(scenarioNow.getTime() + HOUR_MS),
      state: 'quiescing',
    });

    scenarioNow = new Date(scenarioNow.getTime() + HOUR_MS + 1);
    await expect(
      controlledVideosService.reconcilePendingExternalResources({ limit: 10 }),
    ).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: reservedTarget.id },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });

    if (!writtenThumbnail) {
      throw new Error('Reserved source thumbnail was not written after video deletion');
    }

    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: writtenThumbnail.bucket,
        objectKey: writtenThumbnail.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('reserves uploads before S3, publishes immutable sources, and keeps replaced bytes reserved', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-source-owner@example.com',
      username: 'video_source_owner',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Durable source replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const firstBody = Buffer.from('first immutable source');
    const first = await uploadVideoSource(runtime.videosService, {
      body: firstBody,
      userId: owner.userId,
      videoId: created.video.id,
    });
    const firstTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: {
        id: (
          await runtime.prisma.videoUploadSession.findUniqueOrThrow({
            where: { id: first.uploadSession.id },
            select: { externalResourceTargetId: true },
          })
        ).externalResourceTargetId,
      },
    });

    expect(first.uploadSession.objectKey).toBe(
      `${owner.userId}/${created.video.id}/sources/${first.uploadSession.id}/original.mp4`,
    );
    expect(first.uploadSession.expectedSizeBytes).toBe(firstBody.length);
    expect(firstTarget).toMatchObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      selector: first.uploadSession.objectKey,
      selectorKind: 'exact',
      role: 'source',
      goal: 'present',
      state: 'confirmed_present',
      expectedSizeBytes: BigInt(firstBody.length),
    });
    const firstParts = await runtime.prisma.videoUploadPart.findMany({
      where: { uploadSessionId: first.uploadSession.id },
      select: {
        partNumber: true,
        etag: true,
      },
      orderBy: { partNumber: 'asc' },
    });
    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        uploadSessionId: first.uploadSession.id,
        parts: firstParts,
      }),
    ).resolves.toMatchObject({
      uploadSession: {
        id: first.uploadSession.id,
        status: 'completed',
      },
    });
    await expect(
      runtime.prisma.videoTranscodeJob.count({
        where: {
          videoId: created.video.id,
          sourceObjectKey: first.uploadSession.objectKey,
        },
      }),
    ).resolves.toBe(1);

    const secondBody = Buffer.from('second immutable source is different');
    const replacementRequestedAt = Date.now();
    const second = await uploadVideoSource(runtime.videosService, {
      body: secondBody,
      userId: owner.userId,
      videoId: created.video.id,
    });
    const replacementCompletedAt = Date.now();
    const [video, replacedTarget, reserved] = await Promise.all([
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          sourceUploadSessionId: true,
          sourceObjectKey: true,
          sourceSizeBytes: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: firstTarget.id },
      }),
      runtime.prisma.externalResourceTarget.aggregate({
        where: {
          userId: owner.userId,
          role: 'source',
          state: { not: 'confirmed_absent' },
        },
        _sum: { expectedSizeBytes: true },
      }),
    ]);

    expect(second.uploadSession.objectKey).not.toBe(first.uploadSession.objectKey);
    expect(video).toEqual({
      sourceUploadSessionId: second.uploadSession.id,
      sourceObjectKey: second.uploadSession.objectKey,
      sourceSizeBytes: BigInt(secondBody.length),
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    expect(replacedTarget.quiescenceNotBefore?.getTime()).toBeGreaterThanOrEqual(
      replacementRequestedAt + 60 * 60 * 1000,
    );
    expect(replacedTarget.quiescenceNotBefore?.getTime()).toBeLessThanOrEqual(
      replacementCompletedAt + 60 * 60 * 1000,
    );
    expect(reserved._sum.expectedSizeBytes).toBe(BigInt(firstBody.length + secondBody.length));

    const quotaBoundService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      {
        maxUploadBytes: 1,
        userStorageQuotaBytes: firstBody.length + secondBody.length,
      },
    );

    await expect(
      quotaBoundService.initMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: firstTarget.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });

    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: firstTarget.bucket,
        objectKey: firstTarget.selector,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: firstTarget.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'confirmed_absent' });

    const afterCleanup = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: 'source',
        state: { not: 'confirmed_absent' },
      },
      _sum: { expectedSizeBytes: true },
    });
    expect(afterCleanup._sum.expectedSizeBytes).toBe(BigInt(secondBody.length));
  });

  test('counts source thumbnails in the video quota and blocks repeated near-limit reservations', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-quota-abuse@example.com',
      username: 'thumb_quota_abuse',
    });
    const noisyPixels = randomBytes(1280 * 720 * 3);
    const nearUploadLimitThumbnail = await sharp(noisyPixels, {
      raw: {
        width: 1280,
        height: 720,
        channels: 3,
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const normalized = await createUserMediaProcessor({
      profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    }).processVideoThumbnail({
      buffer: nearUploadLimitThumbnail,
      size: nearUploadLimitThumbnail.length,
    });

    expect(nearUploadLimitThumbnail.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(nearUploadLimitThumbnail.length).toBeLessThan(PROFILE_MEDIA_MAX_UPLOAD_BYTES);

    const videos = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        runtime?.videosService.createVideo({
          userId: owner.userId,
          title: `Thumbnail quota abuse ${index}`,
          description: null,
          tags: [],
          license: 'all_rights_reserved',
          visibility: 'unlisted',
          allowComments: true,
        }),
      ),
    );
    const quotaBytes = 3 + normalized.sizeBytes * 2;
    const quotaBoundService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      {
        userStorageQuotaBytes: quotaBytes,
      },
    );
    const sessions = [];

    for (const created of videos) {
      if (!created) {
        throw new Error('Quota abuse video creation did not return a video');
      }

      sessions.push(
        await quotaBoundService.initMultipartUpload({
          userId: owner.userId,
          videoId: created.video.id,
          sizeBytes: 1,
        }),
      );
    }

    for (let index = 0; index < 2; index += 1) {
      const created = videos[index];
      const session = sessions[index];

      if (!created || !session) {
        throw new Error('Quota abuse setup is incomplete');
      }

      await expect(
        quotaBoundService.uploadSourceThumbnail({
          userId: owner.userId,
          videoId: created.video.id,
          uploadSessionId: session.uploadSession.id,
          file: {
            buffer: nearUploadLimitThumbnail,
            size: nearUploadLimitThumbnail.length,
          },
        }),
      ).resolves.toMatchObject({
        thumbnail: {
          sizeBytes: normalized.sizeBytes,
        },
      });
    }

    const blockedVideo = videos[2];
    const blockedSession = sessions[2];

    if (!blockedVideo || !blockedSession) {
      throw new Error('Blocked quota abuse setup is incomplete');
    }

    await expect(
      quotaBoundService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: blockedVideo.video.id,
        uploadSessionId: blockedSession.uploadSession.id,
        file: {
          buffer: nearUploadLimitThumbnail,
          size: nearUploadLimitThumbnail.length,
        },
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const reserved = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: {
          in: ['source', 'source_thumbnail'],
        },
        state: {
          not: 'confirmed_absent',
        },
      },
      _sum: {
        expectedSizeBytes: true,
      },
    });

    expect(reserved._sum.expectedSizeBytes).toBe(BigInt(quotaBytes));
    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          userId: owner.userId,
          role: 'source_thumbnail',
        },
      }),
    ).resolves.toBe(2);
  });

  test('publishes the latest confirmed custom thumbnail, cleans its replacement, and serves the generation copy', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'custom-video-thumbnail@example.com',
      username: 'custom_thumb',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Custom video thumbnail',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const firstThumbnail = await createPng(320, 900);
    const secondThumbnail = await sharp({
      create: {
        width: 1_800,
        height: 300,
        channels: 3,
        background: '#f04444',
      },
    })
      .png()
      .toBuffer();
    const source = await uploadVideoSource(runtime.videosService, {
      body: await createTranscodeTestVideo(),
      userId: owner.userId,
      videoId: created.video.id,
      thumbnails: [firstThumbnail, secondThumbnail],
    });
    const confirmedThumbnail = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: source.uploadSession.id,
      },
      include: {
        externalResourceTarget: true,
      },
    });
    const replacedTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        generation: source.uploadSession.id,
        role: 'source_thumbnail',
        id: {
          not: confirmedThumbnail.externalResourceTargetId,
        },
      },
    });
    const normalizedThumbnail = await readStoredObjectBuffer(
      runtime.videoObjectStorage,
      confirmedThumbnail.bucket,
      confirmedThumbnail.objectKey,
    );
    const normalizedMetadata = await sharp(normalizedThumbnail).metadata();

    expect(normalizedMetadata).toMatchObject({
      format: 'webp',
      width: 1280,
      height: 720,
    });
    expect(confirmedThumbnail.externalResourceTarget).toMatchObject({
      userId: owner.userId,
      videoId: created.video.id,
      generation: source.uploadSession.id,
      goal: 'present',
      role: 'source_thumbnail',
      state: 'confirmed_present',
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const reservedBeforeCleanup = await runtime.prisma.externalResourceTarget.aggregate({
      where: {
        userId: owner.userId,
        role: {
          in: ['source', 'source_thumbnail'],
        },
        state: {
          not: 'confirmed_absent',
        },
      },
      _sum: {
        expectedSizeBytes: true,
      },
    });
    const expectedReservedBytes =
      BigInt(source.uploadSession.expectedSizeBytes) +
      (confirmedThumbnail.externalResourceTarget.expectedSizeBytes ?? 0n) +
      (replacedTarget.expectedSizeBytes ?? 0n);

    expect(reservedBeforeCleanup._sum.expectedSizeBytes).toBe(expectedReservedBytes);
    const quotaProbeVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail replacement quota probe',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const replacementQuotaService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      runtime.externalResources,
      {
        maxUploadBytes: 1,
        userStorageQuotaBytes: Number(expectedReservedBytes),
      },
    );

    await expect(
      replacementQuotaService.initMultipartUpload({
        userId: owner.userId,
        videoId: quotaProbeVideo.video.id,
        sizeBytes: 1,
      }),
    ).rejects.toBeInstanceOf(VideoStorageQuotaExceededError);

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: replacedTarget.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: replacedTarget.bucket,
        objectKey: replacedTarget.selector,
      }),
    ).resolves.toBeNull();

    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
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
    });
    expect(runnerErrors).toEqual([]);
    const activeGeneration = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        state: 'active',
      },
      select: {
        bucket: true,
        id: true,
        thumbnailObjectKey: true,
      },
    });
    const manifest = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      activeGeneration.id,
      [],
    );

    expect(activeGeneration.thumbnailObjectKey).toBe(manifest.thumbnail.objectKey);
    await expect(
      readStoredObjectBuffer(
        runtime.videoObjectStorage,
        activeGeneration.bucket,
        manifest.thumbnail.objectKey,
      ),
    ).resolves.toEqual(normalizedThumbnail);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: confirmedThumbnail.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'quiescing',
    });

    const app = await createIntegrationApp(runtime);
    const thumbnailRedirect = await request(app)
      .get(`/videos/${created.video.publicId}/thumbnail`)
      .expect(307)
      .expect('Cache-Control', 'no-store');
    const signedThumbnailUrl = thumbnailRedirect.headers.location;

    if (!signedThumbnailUrl) {
      throw new Error('Public thumbnail redirect did not expose a Location header');
    }

    const signedThumbnail = await fetch(signedThumbnailUrl);

    expect(signedThumbnail.status).toBe(200);
    expect(Buffer.from(await signedThumbnail.arrayBuffer())).toEqual(normalizedThumbnail);
    await request(app)
      .get('/videos/me')
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.videos).toContainEqual(
          expect.objectContaining({
            id: created.video.id,
            processingStatus: 'ready',
            thumbnailObjectKey: manifest.thumbnail.objectKey,
          }),
        );
      });
  });

  test('cleans the confirmed thumbnail of a source replaced before its generation is published', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'replaced-source-thumbnail@example.com',
      username: 'replaced_src_thumb',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Replaced source thumbnail cleanup',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceA = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source A before publication'),
      userId: owner.userId,
      videoId: created.video.id,
      thumbnails: [await createPng(1600, 900)],
    });
    const thumbnailA = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: sourceA.uploadSession.id,
      },
      include: {
        externalResourceTarget: true,
      },
    });

    expect(thumbnailA.externalResourceTarget).toMatchObject({
      goal: 'present',
      state: 'confirmed_present',
    });
    await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source B replaces A before its job is claimed'),
      userId: owner.userId,
      videoId: created.video.id,
    });

    const scheduled = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: {
        id: thumbnailA.externalResourceTargetId,
      },
    });

    expect(scheduled).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: thumbnailA.externalResourceTargetId,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: thumbnailA.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: {
          uploadSessionId: sourceA.uploadSession.id,
        },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: thumbnailA.bucket,
        objectKey: thumbnailA.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('rejects thumbnail IDOR before creating an external reservation', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const [owner, otherUser] = await Promise.all([
      createVerifiedSession(runtime, {
        email: 'thumbnail-owner@example.com',
        username: 'thumb_owner',
      }),
      createVerifiedSession(runtime, {
        email: 'thumbnail-attacker@example.com',
        username: 'thumb_attacker',
      }),
    ]);
    const [ownedVideo, otherVideo] = await Promise.all([
      runtime.videosService.createVideo({
        userId: owner.userId,
        title: 'Owned thumbnail session',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      }),
      runtime.videosService.createVideo({
        userId: owner.userId,
        title: 'Other owned video',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      }),
    ]);
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: ownedVideo.video.id,
      sizeBytes: 64,
    });
    const thumbnail = await createPng();
    const countBefore = await runtime.prisma.externalResourceTarget.count({
      where: {
        role: 'source_thumbnail',
      },
    });

    await expect(
      runtime.videosService.uploadSourceThumbnail({
        userId: otherUser.userId,
        videoId: ownedVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(VideoUploadSessionNotFoundError);
    await expect(
      runtime.videosService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: otherVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(VideoUploadSessionNotFoundError);
    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          role: 'source_thumbnail',
        },
      }),
    ).resolves.toBe(countBefore);
  });

  test('serializes thumbnail and source finalization transactions released by the same barrier', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-finalization-barrier@example.com',
      username: 'thumb_final_barrier',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail finalization barrier',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceBody = Buffer.from('source finalized against thumbnail');
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: sourceBody.length,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const sourcePut = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body: sourceBody,
    });
    const etag = sourcePut.headers.get('etag');

    if (!etag) {
      throw new Error('Concurrent finalization source PUT did not return an ETag');
    }

    const thumbnailPrisma = createPrismaClient(runtime.databaseUrl);
    const completePrisma = createPrismaClient(runtime.databaseUrl);
    const lockPrisma = createPrismaClient(runtime.databaseUrl);
    const thumbnailStored = Promise.withResolvers<void>();
    const releaseThumbnailPut = Promise.withResolvers<void>();
    const bothHeadsCompleted = Promise.withResolvers<void>();
    const releaseHeads = Promise.withResolvers<void>();
    let completedHeads = 0;
    const barrierStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        await activeRuntime.videoObjectStorage.putObject(input);
        thumbnailStored.resolve();
        await releaseThumbnailPut.promise;
      },
      headObject: async (input) => {
        const object = await activeRuntime.videoObjectStorage.headObject(input);

        completedHeads += 1;
        if (completedHeads === 2) {
          bothHeadsCompleted.resolve();
        }
        await releaseHeads.promise;

        return object;
      },
    };
    const thumbnailExternalResources = createExternalResourceReconciler({
      prisma: thumbnailPrisma,
      objectStorage: barrierStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const completeExternalResources = createExternalResourceReconciler({
      prisma: completePrisma,
      objectStorage: barrierStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const thumbnailService = createIntegrationVideosService(
      thumbnailPrisma,
      barrierStorage,
      thumbnailExternalResources,
    );
    const completeService = createIntegrationVideosService(
      completePrisma,
      barrierStorage,
      completeExternalResources,
    );
    const thumbnail = await createPng(900, 1200);
    const thumbnailPromise = thumbnailService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: thumbnail,
        size: thumbnail.length,
      },
    });

    await thumbnailStored.promise;
    const completePromise = completeService.completeMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      parts: [{ partNumber: 1, etag }],
    });
    releaseThumbnailPut.resolve();

    await Promise.race([
      bothHeadsCompleted.promise,
      delay(10_000).then(() => {
        throw new Error('Both reconciliations did not reach HEAD verification');
      }),
    ]);

    const lockAcquired = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const lockTransaction = lockPrisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE "video_upload_sessions" IN ACCESS EXCLUSIVE MODE');
        lockAcquired.resolve();
        await releaseLock.promise;
      },
      {
        timeout: 15_000,
      },
    );
    let blockedFinalizations = 0;

    try {
      await Promise.race([
        lockAcquired.promise,
        delay(5_000).then(() => {
          throw new Error('Finalization lock could not be acquired');
        }),
      ]);
      releaseHeads.resolve();

      const blockedDeadline = Date.now() + 5_000;

      while (Date.now() < blockedDeadline) {
        const [activity] = await runtime.prisma.$queryRaw<Array<{ blocked_count: number }>>`
          SELECT count(*)::int AS blocked_count
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%video_upload_sessions%'
        `;
        blockedFinalizations = activity?.blocked_count ?? 0;

        if (blockedFinalizations >= 2) {
          break;
        }

        await delay(25);
      }
    } finally {
      releaseLock.resolve();
      releaseHeads.resolve();
      await lockTransaction;
      await lockPrisma.$disconnect();
    }

    let thumbnailResult: PromiseSettledResult<Awaited<typeof thumbnailPromise>>;
    let completeResult: PromiseSettledResult<Awaited<typeof completePromise>>;

    try {
      [thumbnailResult, completeResult] = await Promise.allSettled([
        thumbnailPromise,
        completePromise,
      ]);
    } finally {
      await Promise.all([thumbnailPrisma.$disconnect(), completePrisma.$disconnect()]);
    }

    expect(blockedFinalizations).toBeGreaterThanOrEqual(2);
    expect(completeResult.status).toBe('fulfilled');

    const [storedSession, thumbnailTargets] = await Promise.all([
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: {
          id: initialized.uploadSession.id,
        },
        include: {
          sourceThumbnail: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          generation: initialized.uploadSession.id,
          role: 'source_thumbnail',
        },
      }),
    ]);

    expect(storedSession.status).toBe('completed');
    expect(thumbnailTargets).toHaveLength(1);
    const thumbnailTarget = thumbnailTargets[0];

    if (!thumbnailTarget) {
      throw new Error('Concurrent thumbnail target was not persisted');
    }

    if (storedSession.sourceThumbnail) {
      expect(thumbnailResult.status).toBe('fulfilled');
      expect(storedSession.sourceThumbnail.externalResourceTargetId).toBe(thumbnailTarget.id);
      expect(thumbnailTarget).toMatchObject({
        goal: 'present',
        state: 'confirmed_present',
      });
    } else {
      expect(thumbnailResult.status).toBe('rejected');
      if (thumbnailResult.status === 'rejected') {
        expect(thumbnailResult.reason).toBeInstanceOf(InvalidVideoUploadSessionStateError);
      }
      expect(thumbnailTarget).toMatchObject({
        goal: 'absent',
        state: 'quiescing',
      });
    }
  });

  test('finalizes two parallel thumbnails with one winner and one fully tracked cleanup', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    const owner = await createVerifiedSession(runtime, {
      email: 'parallel-thumbnails@example.com',
      username: 'parallel_thumbnails',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Parallel thumbnail replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: 1,
    });
    const firstPrisma = createPrismaClient(runtime.databaseUrl);
    const secondPrisma = createPrismaClient(runtime.databaseUrl);
    const putBarrier = createOneShotBarrier(2);
    const parallelStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      putObject: async (input) => {
        await activeRuntime.videoObjectStorage.putObject(input);
        await putBarrier();
      },
    };
    const firstExternalResources = createExternalResourceReconciler({
      prisma: firstPrisma,
      objectStorage: parallelStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const secondExternalResources = createExternalResourceReconciler({
      prisma: secondPrisma,
      objectStorage: parallelStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });
    const firstService = createIntegrationVideosService(
      firstPrisma,
      parallelStorage,
      firstExternalResources,
    );
    const secondService = createIntegrationVideosService(
      secondPrisma,
      parallelStorage,
      secondExternalResources,
    );
    const [firstThumbnail, secondThumbnail] = await Promise.all([
      createPng(900, 900),
      createPng(1800, 600),
    ]);
    const firstUpload = firstService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: firstThumbnail,
        size: firstThumbnail.length,
      },
    });
    const secondUpload = secondService.uploadSourceThumbnail({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      file: {
        buffer: secondThumbnail,
        size: secondThumbnail.length,
      },
    });
    let first: PromiseSettledResult<Awaited<typeof firstUpload>>;
    let second: PromiseSettledResult<Awaited<typeof secondUpload>>;

    try {
      [first, second] = await Promise.allSettled([firstUpload, secondUpload]);
    } finally {
      await Promise.all([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
    }

    if (![first, second].some((result) => result.status === 'fulfilled')) {
      throw new AggregateError(
        [first, second].flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        'Both parallel thumbnail uploads failed',
      );
    }
    const [linkedThumbnail, targets] = await Promise.all([
      runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
        where: {
          uploadSessionId: initialized.uploadSession.id,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: {
          generation: initialized.uploadSession.id,
          role: 'source_thumbnail',
        },
        orderBy: {
          createdAt: 'asc',
        },
      }),
    ]);

    expect(targets).toHaveLength(2);
    const winner = targets.find((target) => target.id === linkedThumbnail.externalResourceTargetId);
    const loser = targets.find((target) => target.id !== linkedThumbnail.externalResourceTargetId);

    expect(winner).toMatchObject({
      goal: 'present',
      state: 'confirmed_present',
    });
    expect(loser).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });

    if (!winner || !loser) {
      throw new Error('Parallel thumbnail winner and loser were not both persisted');
    }

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: loser.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: loser.id,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'confirmed_absent',
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: loser.bucket,
        objectKey: loser.selector,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: winner.bucket,
        objectKey: winner.selector,
      }),
    ).resolves.toMatchObject({
      sizeBytes: linkedThumbnail.sizeBytes,
    });
  });

  test('discards a thumbnail whose PUT races with complete and transcodes with the ffmpeg fallback', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'thumbnail-complete-race@example.com',
      username: 'thumb_race',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Thumbnail complete race',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceBody = await createTranscodeTestVideo();
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: sourceBody.length,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const sourcePut = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body: sourceBody,
    });
    const etag = sourcePut.headers.get('etag');

    if (!etag) {
      throw new Error('Multipart source upload did not return an ETag');
    }

    let racedThumbnail:
      | {
          body: Buffer;
          bucket: string;
          objectKey: string;
        }
      | undefined;
    const raceService = createIntegrationVideosService(
      runtime.prisma,
      {
        ...runtime.videoObjectStorage,
        putObject: async (input) => {
          await runtime?.videoObjectStorage.putObject(input);
          racedThumbnail = {
            body: input.body,
            bucket: input.bucket ?? VIDEO_OBJECT_STORAGE_BUCKET,
            objectKey: input.objectKey,
          };
          await runtime?.videosService.completeMultipartUpload({
            userId: owner.userId,
            videoId: created.video.id,
            uploadSessionId: initialized.uploadSession.id,
            parts: [{ partNumber: 1, etag }],
          });
        },
      },
      runtime.externalResources,
    );
    const thumbnail = await createPng(300, 900);

    await expect(
      raceService.uploadSourceThumbnail({
        userId: owner.userId,
        videoId: created.video.id,
        uploadSessionId: initialized.uploadSession.id,
        file: { buffer: thumbnail, size: thumbnail.length },
      }),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    expect(racedThumbnail).toBeDefined();
    const app = await createIntegrationApp(runtime);
    await request(app)
      .put(`/videos/${created.video.id}/upload/multipart/${initialized.uploadSession.id}/thumbnail`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .attach('thumbnail', thumbnail, {
        contentType: 'image/png',
        filename: 'late-thumbnail.png',
      })
      .expect(409);
    await expect(
      runtime.prisma.videoSourceThumbnail.findUnique({
        where: {
          uploadSessionId: initialized.uploadSession.id,
        },
      }),
    ).resolves.toBeNull();

    const thumbnailTarget = await runtime.prisma.externalResourceTarget.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        generation: initialized.uploadSession.id,
        role: 'source_thumbnail',
      },
    });
    expect(thumbnailTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
    });
    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: {
        id: thumbnailTarget.id,
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(raceService.reconcilePendingExternalResources()).resolves.toMatchObject({
      confirmed: 1,
      failed: 0,
    });
    const writtenThumbnail = racedThumbnail as
      | { body: Buffer; bucket: string; objectKey: string }
      | undefined;

    if (!writtenThumbnail) {
      throw new Error('Raced thumbnail PUT was not observed');
    }

    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: writtenThumbnail.bucket,
        objectKey: writtenThumbnail.objectKey,
      }),
    ).resolves.toBeNull();

    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
      },
      select: {
        id: true,
      },
    });
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: testLogger,
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

    const activeGeneration = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        state: 'active',
      },
      select: {
        bucket: true,
        id: true,
      },
    });
    const fallbackObjectKey = buildVideoArtifactManifest(
      owner.userId,
      created.video.id,
      activeGeneration.id,
      [],
    ).thumbnail.objectKey;
    const fallbackThumbnail = await readStoredObjectBuffer(
      runtime.videoObjectStorage,
      activeGeneration.bucket,
      fallbackObjectKey,
    );

    expect(fallbackThumbnail).not.toEqual(writtenThumbnail.body);
    await expect(sharp(fallbackThumbnail).metadata()).resolves.toMatchObject({
      format: 'webp',
    });
  });

  test('keeps a custom-thumbnail generation writing and cleans it when poster HEAD verification fails', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'custom-thumbnail-head-failure@example.com',
      username: 'thumb_head_failure',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Custom thumbnail HEAD failure',
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
      thumbnails: [await createPng(1600, 900)],
    });
    const sourceThumbnail = await runtime.prisma.videoSourceThumbnail.findUniqueOrThrow({
      where: {
        uploadSessionId: source.uploadSession.id,
      },
      select: {
        externalResourceTargetId: true,
      },
    });
    const job = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
      },
    });
    let failedPosterKey: string | null = null;
    const verificationFailureStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      headObject: async (input) => {
        if (input.objectKey.endsWith('/thumbnail/poster.webp')) {
          failedPosterKey = input.objectKey;
          return null;
        }

        return runtime?.videoObjectStorage.headObject(input) ?? null;
      },
    };
    const runner = createVideoTranscodeRunner({
      prisma: runtime.prisma,
      objectStorage: verificationFailureStorage,
      clock: { now: () => new Date() },
      config: {
        maxConcurrentJobs: 1,
        threadsPerJob: 1,
      },
      logger: testLogger,
    });

    runner.start();
    let failedJob:
      | {
          attempts: number;
          lastError: string | null;
          status: 'queued' | 'processing' | 'completed' | 'failed';
        }
      | undefined;
    const retryDeadline = Date.now() + 40_000;

    try {
      while (Date.now() < retryDeadline) {
        const observed = await runtime.prisma.videoTranscodeJob.findUniqueOrThrow({
          where: {
            id: job.id,
          },
          select: {
            attempts: true,
            lastError: true,
            status: true,
          },
        });

        if (observed.status === 'queued' && observed.attempts === 1 && observed.lastError) {
          failedJob = observed;
          break;
        }

        await delay(200);
      }
    } finally {
      await runner.stop();
    }

    expect(failedJob).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('Uploaded artifact could not be verified'),
      status: 'queued',
    });
    expect(failedPosterKey).toMatch(/\/thumbnail\/poster\.webp$/u);

    const generation = await runtime.prisma.videoArtifactGeneration.findFirstOrThrow({
      where: {
        videoId: created.video.id,
      },
      select: {
        id: true,
        state: true,
      },
    });
    const cleanupTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        generation: generation.id,
        role: {
          in: ['hls_artifacts', 'thumbnail_prefix'],
        },
      },
    });

    expect(generation.state).toBe('writing');
    expect(cleanupTargets).toHaveLength(2);
    expect(
      cleanupTargets.every((target) => target.goal === 'absent' && target.state === 'quiescing'),
    ).toBe(true);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: sourceThumbnail.externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'present',
      state: 'confirmed_present',
    });

    const cleanupDueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.updateMany({
      where: {
        generation: generation.id,
        role: {
          in: ['hls_artifacts', 'thumbnail_prefix'],
        },
      },
      data: {
        quiescenceNotBefore: cleanupDueAt,
        nextAttemptAt: cleanupDueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 2,
      confirmed: 2,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: {
          id: generation.id,
        },
        select: {
          state: true,
        },
      }),
    ).resolves.toEqual({
      state: 'retired',
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        objectKey: failedPosterKey ?? '',
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

  test('prevents a stale Redis lock owner from touching a lock reacquired after expiration', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const ttlMs = 100;
    const firstManager = createRedisMaintenanceCleanupLock({
      redisClient: runtime.redisClient,
      ttlMs,
      tokenFactory: () => 'expired-maintenance-instance',
    });
    const secondManager = createRedisMaintenanceCleanupLock({
      redisClient: runtime.redisClient,
      ttlMs: 5_000,
      tokenFactory: () => 'replacement-maintenance-instance',
    });
    const firstLock = await firstManager.acquire();

    if (!firstLock) {
      throw new Error('First maintenance lock was not acquired');
    }

    await delay(ttlMs * 2);
    const secondLock = await secondManager.acquire();

    if (!secondLock) {
      throw new Error('Replacement maintenance lock was not acquired after expiration');
    }

    await expect(firstLock.renew()).resolves.toBe(false);
    await firstLock.release();
    await expect(runtime.redisClient.call('get', 'maintenance:cleanup:lock')).resolves.toBe(
      'replacement-maintenance-instance',
    );
    expect(
      Number(await runtime.redisClient.call('pttl', 'maintenance:cleanup:lock')),
    ).toBeGreaterThan(0);
    await secondLock.release();
  });

  test('renews the real Redis maintenance lock, excludes a second instance, and detects token loss', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const firstStepStarted = Promise.withResolvers<void>();
    const releaseFirstStep = Promise.withResolvers<void>();
    const createMaintenanceServices = (calls: string[], blockFirstStep: boolean) => ({
      authService: {
        cleanupSessions: async () => {
          calls.push('sessions');

          if (blockFirstStep) {
            firstStepStarted.resolve();
            await releaseFirstStep.promise;
          }

          return {
            message: 'sessions cleaned',
            sessionsDeleted: 0,
          };
        },
        cleanupExpiredAuthTokens: async () => {
          calls.push('authTokens');
          return {
            message: 'tokens cleaned',
            emailVerificationTokensDeleted: 0,
            passwordResetTokensDeleted: 0,
          };
        },
        reconcileUserMediaTargets: async () => {
          calls.push('userMediaTargets');
          return {
            message: 'media reconciled',
            mediaTargetsConfirmed: 0,
            mediaTargetsFailed: 0,
          };
        },
      },
      videosService: {
        expireMultipartUploadSessions: async () => {
          calls.push('multipartSessions');
          return { uploadSessionsExpired: 0 };
        },
        scheduleAbandonedArtifactGenerations: async () => {
          calls.push('abandonedArtifactGenerations');
          return { artifactGenerationsScheduled: 0 };
        },
        reconcilePendingExternalResources: async () => {
          calls.push('videoTargets');
          return {
            claimed: 0,
            confirmed: 0,
            redirectedAbsent: 0,
            failed: 0,
          };
        },
        deleteExpiredRejectedVideos: async () => {
          calls.push('rejectedVideos');
          return {
            rejectedVideosDeleted: 0,
            rejectedVideoTargetsScheduled: 0,
          };
        },
      },
    });
    const lockTtlMs = 300;
    const firstJob = createMaintenanceCleanupJob({
      ...createMaintenanceServices(firstCalls, true),
      clock: { now: () => new Date() },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock: createRedisMaintenanceCleanupLock({
        redisClient: runtime.redisClient,
        ttlMs: lockTtlMs,
        tokenFactory: () => 'first-maintenance-instance',
      }),
      logger: testLogger,
    });
    const secondJob = createMaintenanceCleanupJob({
      ...createMaintenanceServices(secondCalls, false),
      clock: { now: () => new Date() },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 1_000,
      },
      lock: createRedisMaintenanceCleanupLock({
        redisClient: runtime.redisClient,
        ttlMs: lockTtlMs,
        tokenFactory: () => 'second-maintenance-instance',
      }),
      logger: testLogger,
    });

    const firstRun = firstJob.runOnce();
    await firstStepStarted.promise;
    await delay(lockTtlMs * 2);
    const secondResult = await secondJob.runOnce();
    await runtime.redisClient.call(
      'set',
      'maintenance:cleanup:lock',
      'intruder-token',
      'PX',
      '5000',
    );
    await delay(150);
    releaseFirstStep.resolve();
    const firstResult = await firstRun;
    const retainedToken = await runtime.redisClient.call('get', 'maintenance:cleanup:lock');
    await runtime.redisClient.call('del', 'maintenance:cleanup:lock');

    expect(secondResult).toEqual({
      skipped: true,
      lockLost: false,
      summary: {},
      failedSteps: [],
    });
    expect(secondCalls).toEqual([]);
    expect(firstCalls).toEqual(['sessions']);
    expect(firstResult).toEqual({
      skipped: false,
      lockLost: true,
      summary: {
        sessionsDeleted: 0,
      },
      failedSteps: ['lockOwnership'],
    });
    expect(retainedToken).toBe('intruder-token');
  });

  test('maintenance expires multipart sessions and schedules only abandoned writing generations', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const observedAt = new Date('2026-07-24T12:00:00.000Z');
    const staleAt = new Date(observedAt.getTime() - 60_000);
    const owner = await createVerifiedSession(runtime, {
      email: 'maintenance-video@example.com',
      username: 'maintenance_video',
    });
    const expiringVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Expired multipart',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const expiringUpload = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: expiringVideo.video.id,
      sizeBytes: 128,
    });
    await runtime.prisma.videoUploadSession.update({
      where: { id: expiringUpload.uploadSession.id },
      data: { expiresAt: staleAt },
    });

    const createWritingGeneration = async ({ live, title }: { live: boolean; title: string }) => {
      const created = await runtime?.videosService.createVideo({
        userId: owner.userId,
        title,
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      });

      if (!runtime || !created) {
        throw new Error('Integration runtime disappeared');
      }

      const source = await uploadVideoSource(runtime.videosService, {
        body: Buffer.from(`${title} source`),
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
      const executionId = randomUUID();

      if (live) {
        await runtime.prisma.videoTranscodeJob.update({
          where: { id: job.id },
          data: {
            status: 'processing',
            attempts: 1,
            executionId,
            heartbeatAt: observedAt,
            startedAt: observedAt,
          },
        });
      }

      const generationId = randomUUID();
      const manifest = buildVideoArtifactManifest(owner.userId, created.video.id, generationId, []);
      await runtime.prisma.videoArtifactGeneration.create({
        data: {
          id: generationId,
          videoId: created.video.id,
          sourceUploadSessionId: source.uploadSession.id,
          transcodeJobId: job.id,
          executionId,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          state: 'writing',
          hlsMasterObjectKey: manifest.master.objectKey,
          thumbnailObjectKey: manifest.thumbnail.objectKey,
          updatedAt: staleAt,
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
            nextAttemptAt: new Date(observedAt.getTime() + 60 * 60 * 1000),
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
            nextAttemptAt: new Date(observedAt.getTime() + 60 * 60 * 1000),
          },
        ],
      });

      return { generationId };
    };

    const abandoned = await createWritingGeneration({
      live: false,
      title: 'Abandoned generation',
    });
    const live = await createWritingGeneration({
      live: true,
      title: 'Live generation',
    });
    const maintenanceExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => observedAt },
      logger: testLogger,
    });
    const cleanup = createMaintenanceCleanupJob({
      authService: runtime.authService,
      videosService: createIntegrationVideosService(
        runtime.prisma,
        runtime.videoObjectStorage,
        maintenanceExternalResources,
      ),
      clock: { now: () => observedAt },
      config: {
        intervalMs: 60_000,
        inactiveRetentionMs: 30 * 24 * 60 * 60 * 1000,
      },
      logger: testLogger,
    });

    const result = await cleanup.runOnce();
    expect(result).toMatchObject({
      skipped: false,
      lockLost: false,
      failedSteps: [],
      summary: {
        uploadSessionsExpired: 1,
        artifactGenerationsScheduled: 1,
        videoTargetsClaimed: 0,
        videoTargetsConfirmed: 0,
        videoTargetsFailed: 0,
      },
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: expiringUpload.uploadSession.id },
        select: {
          externalResourceTarget: {
            select: {
              goal: true,
              quiescenceNotBefore: true,
              state: true,
            },
          },
          status: true,
        },
      }),
    ).resolves.toEqual({
      status: 'expiring',
      externalResourceTarget: {
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: new Date(observedAt.getTime() + 60 * 60 * 1000),
      },
    });
    const [abandonedTargets, liveTargets] = await Promise.all([
      runtime.prisma.externalResourceTarget.findMany({
        where: { generation: abandoned.generationId },
        select: {
          attempts: true,
          goal: true,
          nextAttemptAt: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
      runtime.prisma.externalResourceTarget.findMany({
        where: { generation: live.generationId },
        select: {
          goal: true,
          quiescenceNotBefore: true,
          state: true,
        },
      }),
    ]);
    expect(abandonedTargets).toHaveLength(2);
    expect(
      abandonedTargets.every(
        (target) =>
          target.attempts === 0 &&
          target.goal === 'absent' &&
          target.state === 'quiescing' &&
          target.quiescenceNotBefore?.getTime() === observedAt.getTime() + 60 * 60 * 1000 &&
          target.nextAttemptAt.getTime() === observedAt.getTime() + 60 * 60 * 1000,
      ),
    ).toBe(true);
    expect(liveTargets).toEqual([
      {
        goal: 'present',
        quiescenceNotBefore: null,
        state: 'writing',
      },
      {
        goal: 'present',
        quiescenceNotBefore: null,
        state: 'writing',
      },
    ]);
  });

  test('keeps an S3 initialization failure durably scheduled after the PostgreSQL reservation', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-init-failure@example.com',
      username: 'video_init_failure',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Ambiguous initialization',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    let observedReservation = false;
    const failingStorage: ObjectStorage = {
      ...runtime.videoObjectStorage,
      initiateMultipartUpload: async () => {
        const [sessionCount, targetCount] = await Promise.all([
          runtime?.prisma.videoUploadSession.count({
            where: {
              videoId: created.video.id,
              status: 'initializing',
            },
          }),
          runtime?.prisma.externalResourceTarget.count({
            where: {
              videoId: created.video.id,
              state: 'writing',
            },
          }),
        ]);
        observedReservation = sessionCount === 1 && targetCount === 1;
        throw new Error('simulated ambiguous S3 initialization failure');
      },
    };
    const service = createIntegrationVideosService(
      runtime.prisma,
      failingStorage,
      runtime.externalResources,
    );

    await expect(
      service.initMultipartUpload({
        userId: owner.userId,
        videoId: created.video.id,
        sizeBytes: 128,
      }),
    ).rejects.toThrow('simulated ambiguous S3 initialization failure');
    expect(observedReservation).toBe(true);

    const session = await runtime.prisma.videoUploadSession.findFirstOrThrow({
      where: { videoId: created.video.id },
      include: {
        externalResourceTarget: true,
        multipartHandle: true,
      },
    });

    expect(session.status).toBe('aborting');
    expect(session.multipartHandle).toBeNull();
    expect(session.externalResourceTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
      mayHaveMultipartUpload: true,
    });
    expect(session.externalResourceTarget.quiescenceNotBefore).not.toBeNull();
  });

  test('serializes concurrent upload reservations before S3 and durably rejects a size mismatch', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-concurrent-upload@example.com',
      username: 'video_concurrent',
    });
    const firstVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Concurrent reservation',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const reservations = await Promise.allSettled([
      runtime.videosService.initMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        sizeBytes: 32,
      }),
      runtime.videosService.initMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        sizeBytes: 32,
      }),
    ]);
    const acceptedReservation = reservations.find(
      (reservation) => reservation.status === 'fulfilled',
    );
    const rejectedReservation = reservations.find(
      (reservation) => reservation.status === 'rejected',
    );

    expect(acceptedReservation?.status).toBe('fulfilled');
    expect(rejectedReservation?.status).toBe('rejected');

    if (acceptedReservation?.status !== 'fulfilled' || rejectedReservation?.status !== 'rejected') {
      throw new Error('Concurrent reservation result was not split between success and conflict');
    }

    expect(rejectedReservation.reason).toBeInstanceOf(ActiveVideoUploadSessionExistsError);
    expect(
      await runtime.prisma.videoUploadSession.count({
        where: {
          videoId: firstVideo.video.id,
          status: { in: ['initializing', 'initiated', 'uploading', 'completing'] },
        },
      }),
    ).toBe(1);

    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: firstVideo.video.id,
        uploadSessionId: acceptedReservation.value.uploadSession.id,
        parts: [
          { partNumber: 1, etag: '"duplicate-a"' },
          { partNumber: 1, etag: '"duplicate-b"' },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);

    const abortedReservation = await runtime.videosService.abortMultipartUpload({
      userId: owner.userId,
      videoId: firstVideo.video.id,
      uploadSessionId: acceptedReservation.value.uploadSession.id,
    });
    expect(abortedReservation.uploadSession.status).toBe('aborting');
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: {
          id: (
            await runtime.prisma.videoUploadSession.findUniqueOrThrow({
              where: { id: acceptedReservation.value.uploadSession.id },
              select: { externalResourceTargetId: true },
            })
          ).externalResourceTargetId,
        },
        select: {
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      goal: 'absent',
      state: 'quiescing',
    });

    const secondVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Declared size mismatch',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const body = Buffer.from('shorter than declared');
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: secondVideo.video.id,
      sizeBytes: body.length + 1,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: secondVideo.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: initialized.uploadSession.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'uploading' });
    const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body,
    });
    const etag = uploadResponse.headers.get('etag');

    expect(uploadResponse.status).toBe(200);
    expect(etag).not.toBeNull();

    await expect(
      runtime.videosService.completeMultipartUpload({
        userId: owner.userId,
        videoId: secondVideo.video.id,
        uploadSessionId: initialized.uploadSession.id,
        parts: [{ partNumber: 1, etag: etag ?? '' }],
      }),
    ).rejects.toBeInstanceOf(VideoUploadSizeMismatchError);

    const mismatchedSession = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      include: { externalResourceTarget: true },
    });
    const mismatchedVideo = await runtime.prisma.video.findUniqueOrThrow({
      where: { id: secondVideo.video.id },
      select: {
        sourceUploadSessionId: true,
        sourceObjectKey: true,
        sourceSizeBytes: true,
      },
    });

    expect(mismatchedSession.status).toBe('aborting');
    expect(mismatchedSession.externalResourceTarget).toMatchObject({
      goal: 'absent',
      state: 'quiescing',
      expectedSizeBytes: BigInt(body.length + 1),
    });
    expect(mismatchedVideo).toEqual({
      sourceUploadSessionId: null,
      sourceObjectKey: null,
      sourceSizeBytes: null,
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: initialized.uploadSession.bucket,
        objectKey: initialized.uploadSession.objectKey,
      }),
    ).resolves.toMatchObject({
      sizeBytes: body.length,
    });
  });

  test('redirects a reconciled size mismatch durably without the HTTP completion catch', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-mismatch-crash@example.com',
      username: 'video_mismatch_crash',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Mismatch crash window',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const body = Buffer.from('actual source is larger than its declared reservation');
    const declaredSizeBytes = body.length - 1;
    const initialized = await runtime.videosService.initMultipartUpload({
      userId: owner.userId,
      videoId: created.video.id,
      sizeBytes: declaredSizeBytes,
    });
    const signed = await runtime.videosService.signMultipartUploadParts({
      userId: owner.userId,
      videoId: created.video.id,
      uploadSessionId: initialized.uploadSession.id,
      partNumbers: [1],
    });
    const uploadResponse = await fetch(signed.parts[0]?.url ?? '', {
      method: 'PUT',
      body,
    });
    const etag = uploadResponse.headers.get('etag');

    expect(uploadResponse.status).toBe(200);
    expect(etag).not.toBeNull();

    const session = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      select: {
        externalResourceTargetId: true,
      },
    });
    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.$transaction([
      runtime.prisma.videoUploadSession.update({
        where: { id: initialized.uploadSession.id },
        data: { status: 'completing' },
      }),
      runtime.prisma.videoUploadPart.create({
        data: {
          uploadSessionId: initialized.uploadSession.id,
          partNumber: 1,
          etag: etag ?? '',
        },
      }),
      runtime.prisma.externalResourceTarget.update({
        where: { id: session.externalResourceTargetId },
        data: { nextAttemptAt: dueAt },
      }),
    ]);

    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 0,
      failed: 1,
    });

    const mismatched = await runtime.prisma.videoUploadSession.findUniqueOrThrow({
      where: { id: initialized.uploadSession.id },
      select: {
        status: true,
        externalResourceTarget: {
          select: {
            expectedSizeBytes: true,
            goal: true,
            quiescenceNotBefore: true,
            state: true,
          },
        },
      },
    });

    expect(mismatched).toMatchObject({
      status: 'aborting',
      externalResourceTarget: {
        expectedSizeBytes: BigInt(body.length),
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      },
    });

    await runtime.prisma.externalResourceTarget.update({
      where: { id: session.externalResourceTargetId },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: initialized.uploadSession.id },
        select: {
          status: true,
          externalResourceTarget: {
            select: {
              expectedSizeBytes: true,
              state: true,
            },
          },
        },
      }),
    ).resolves.toEqual({
      status: 'aborted',
      externalResourceTarget: {
        expectedSizeBytes: BigInt(body.length),
        state: 'confirmed_absent',
      },
    });
    await expect(
      runtime.videoObjectStorage.headObject({
        bucket: initialized.uploadSession.bucket,
        objectKey: initialized.uploadSession.objectKey,
      }),
    ).resolves.toBeNull();
  });

  test('finalizes a source reservation crash before S3 initialization as aborted', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'video-initializing-crash@example.com',
      username: 'video_init_crash',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Initializing crash window',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const uploadSessionId = randomUUID();
    const objectKey = videoOriginalKey(owner.userId, created.video.id, uploadSessionId);
    const reservedAt = new Date();
    const target = await runtime.prisma.$transaction(async (tx) => {
      const reservedTarget = await tx.externalResourceTarget.create({
        data: {
          userId: owner.userId,
          videoId: created.video.id,
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          selector: objectKey,
          selectorKind: 'exact',
          role: 'source',
          generation: uploadSessionId,
          expectedSizeBytes: 128n,
          mayHaveMultipartUpload: true,
          goal: 'present',
          state: 'writing',
          nextAttemptAt: reservedAt,
        },
        select: { id: true },
      });
      await tx.videoUploadSession.create({
        data: {
          id: uploadSessionId,
          videoId: created.video.id,
          userId: owner.userId,
          status: 'initializing',
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey,
          partSizeBytes: 67_108_864,
          expectedSizeBytes: 128n,
          expiresAt: new Date(reservedAt.getTime() + 60 * 60 * 1000),
          externalResourceTargetId: reservedTarget.id,
        },
      });
      await tx.video.update({
        where: { id: created.video.id },
        data: { processingStatus: 'uploading' },
      });

      return reservedTarget;
    });

    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 0,
      redirectedAbsent: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: uploadSessionId },
        select: {
          status: true,
          externalResourceTarget: {
            select: {
              goal: true,
              quiescenceNotBefore: true,
              state: true,
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 'initializing',
      externalResourceTarget: {
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      },
    });

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: target.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      runtime.videosService.reconcilePendingExternalResources({ limit: 1 }),
    ).resolves.toMatchObject({
      claimed: 1,
      confirmed: 1,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: uploadSessionId },
        select: {
          abortedAt: true,
          status: true,
        },
      }),
    ).resolves.toEqual({
      abortedAt: expect.any(Date),
      status: 'aborted',
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: { processingStatus: true },
      }),
    ).resolves.toEqual({ processingStatus: 'draft' });
  });

  test('does not confirm absence from an unrecognized proxy 404', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'proxy-404-retry@example.com',
      username: 'proxy_404_retry',
    });
    const generation = randomUUID();
    const target = await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: null,
        bucket: OBJECT_STORAGE_BUCKET,
        selector: `users/${owner.userId}/avatar/${generation}.webp`,
        selectorKind: 'exact',
        role: 'user_media',
        generation,
        expectedSizeBytes: 128n,
        mayHaveMultipartUpload: false,
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: new Date(Date.now() - 1_000),
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
      select: { id: true },
    });
    const proxyStorage = createObjectStorage(
      runtime.objectStorageConfig,
      {
        bucketExists: async () => true,
        makeBucket: async () => undefined,
        putObject: async () => undefined,
        removeObject: async () => undefined,
        statObject: async () => {
          const err = new Error('proxy route missing') as Error & {
            code: string;
            statusCode: number;
          };
          err.code = 'ProxyRouteNotFound';
          err.statusCode = 404;
          throw err;
        },
        presignedGetObject: async () => 'http://localhost/not-used',
      },
      testLogger,
    );
    const proxyReconciler = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: proxyStorage,
      clock: {
        now: () => new Date(),
      },
      logger: testLogger,
    });

    await expect(
      proxyReconciler.reconcileTarget({
        targetId: target.id,
        roles: ['user_media'],
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          attempts: true,
          goal: true,
          state: true,
        },
      }),
    ).resolves.toEqual({
      attempts: 1,
      goal: 'absent',
      state: 'quiescing',
    });
  });

  test('follows and unfollows public profiles through HTTP and Prisma', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const follower = await createVerifiedSession(runtime, {
      email: 'profile-follower@example.com',
      username: 'profile_follower',
    });
    const creator = await createVerifiedSession(runtime, {
      email: 'profile-creator@example.com',
      username: 'profile_creator',
    });

    await request(app)
      .get('/profiles/profile_creator')
      .expect(200)
      .expect((response) => {
        expect(response.body.profile).toEqual(
          expect.objectContaining({
            id: creator.userId,
            username: 'profile_creator',
            followerCount: 0,
            followingCount: 0,
          }),
        );
      });

    await request(app)
      .post('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
            profile: expect.objectContaining({
              id: creator.userId,
              followerCount: 1,
              followingCount: 0,
            }),
          }),
        );
      });

    await expect(
      runtime.prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: follower.userId,
            followingId: creator.userId,
          },
        },
      }),
    ).resolves.toMatchObject({
      followerId: follower.userId,
      followingId: creator.userId,
    });

    await request(app)
      .post('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.followerCount).toBe(1);
      });

    await request(app)
      .get('/profiles/profile_follower')
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.followingCount).toBe(1);
      });

    await request(app)
      .get('/profiles/me/following')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          profiles: [
            {
              id: creator.userId,
              username: 'profile_creator',
              displayName: 'profile_creator',
              avatarUrl: null,
              followedAt: expect.any(String),
            },
          ],
          total: 1,
          nextCursor: null,
        });
      });

    await request(app)
      .post('/profiles/profile_follower/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(400)
      .expect({
        error: 'BadRequest',
        message: SELF_FOLLOW_MESSAGE,
      });

    await request(app)
      .delete('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
            profile: expect.objectContaining({
              followerCount: 0,
            }),
          }),
        );
      });

    await expect(runtime.prisma.userFollow.count()).resolves.toBe(0);

    await request(app)
      .get('/profiles/me/following')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect({
        profiles: [],
        total: 0,
        nextCursor: null,
      });
  });

  test('serves signed GETs and accepts signed multipart PUTs through the public MinIO origin', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const getObjectKey = `integration/signed-get-${randomUUID()}.txt`;
    const getBody = Buffer.from('signed GET through the public origin');
    await runtime.objectStorage.putObject({
      objectKey: getObjectKey,
      body: getBody,
      contentType: 'text/plain',
    });

    const getUrl = await runtime.objectStorage.getSignedUrl(getObjectKey);
    expect(new URL(getUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);
    const getResponse = await fetch(getUrl);
    expect(getResponse.status).toBe(200);
    expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(getBody);

    const multipartObjectKey = `integration/signed-multipart-${randomUUID()}.bin`;
    const multipartBody = Buffer.from('signed multipart PUT through the public origin');
    const { uploadId } = await runtime.objectStorage.initiateMultipartUpload({
      objectKey: multipartObjectKey,
      contentType: 'application/octet-stream',
    });
    const putUrl = await runtime.objectStorage.signMultipartUploadPart({
      objectKey: multipartObjectKey,
      uploadId,
      partNumber: 1,
    });
    expect(new URL(putUrl).origin).toBe(runtime.objectStorageConfig.publicUrl);

    const putResponse = await fetch(putUrl, {
      method: 'PUT',
      body: multipartBody,
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag');

    if (!etag) {
      throw new Error('MinIO multipart PUT response did not include an ETag');
    }

    await runtime.objectStorage.completeMultipartUpload({
      objectKey: multipartObjectKey,
      uploadId,
      parts: [{ partNumber: 1, etag }],
    });

    const completedUrl = await runtime.objectStorage.getSignedUrl(multipartObjectKey);
    const completedResponse = await fetch(completedUrl);
    expect(completedResponse.status).toBe(200);
    expect(Buffer.from(await completedResponse.arrayBuffer())).toEqual(multipartBody);
  });

  test('serves public generation-scoped HLS safely through PostgreSQL and MinIO', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'public-hls@example.com',
      username: 'public_hls',
    });
    const firstVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Public HLS first video',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const firstSource = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('first HLS source'),
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const firstJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: firstVideo.video.id,
        sourceObjectKey: firstSource.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const active = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('active segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'active',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const retiring = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('retiring segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'retiring',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const writing = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('writing segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'writing',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    const retired = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('retired segment bytes'),
      sourceUploadSessionId: firstSource.uploadSession.id,
      state: 'retired',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: firstVideo.video.id,
    });
    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: {
        activeArtifactGenerationId: active.generationId,
        hlsMasterObjectKey: active.manifest.master.objectKey,
        thumbnailObjectKey: active.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const secondVideo = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Public HLS second video',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const secondSource = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('second HLS source'),
      userId: owner.userId,
      videoId: secondVideo.video.id,
    });
    const secondJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: secondVideo.video.id,
        sourceObjectKey: secondSource.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const otherVideoGeneration = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('other video 720p segment bytes'),
      sourceUploadSessionId: secondSource.uploadSession.id,
      state: 'active',
      transcodeJobId: secondJob.id,
      userId: owner.userId,
      videoId: secondVideo.video.id,
      quality: '720p',
    });
    await runtime.prisma.video.update({
      where: { id: secondVideo.video.id },
      data: {
        activeArtifactGenerationId: otherVideoGeneration.generationId,
        hlsMasterObjectKey: otherVideoGeneration.manifest.master.objectKey,
        thumbnailObjectKey: otherVideoGeneration.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const masterPath = `/videos/${firstVideo.video.publicId}/hls/master.m3u8`;
    const activeRenditionPath = `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/index.m3u8`;
    const activeSegmentPath = `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${active.segmentName}`;
    const thumbnailPath = `/videos/${firstVideo.video.publicId}/thumbnail`;
    const masterResponse = await request(app).get(masterPath).expect(200);

    expect(masterResponse.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/u);
    expect(masterResponse.headers['cache-control']).toBe('no-cache');
    expect(masterResponse.text).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"',
    );
    expect(masterResponse.text).toContain(activeRenditionPath);
    expect(masterResponse.text).not.toContain('\n480p/index.m3u8');

    const renditionResponse = await request(app).get(activeRenditionPath).expect(200);

    expect(renditionResponse.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/u);
    expect(renditionResponse.headers['cache-control']).toBe('no-cache');
    expect(renditionResponse.text).toContain('#EXTINF:6.000000,');
    expect(renditionResponse.text).toContain(activeSegmentPath);

    const segmentRedirect = await request(app).get(activeSegmentPath).redirects(0).expect(307);
    const signedSegmentUrl = segmentRedirect.headers.location as string | undefined;

    expect(segmentRedirect.headers['cache-control']).toBe('no-store');
    expect(signedSegmentUrl).toBeDefined();
    expect(new URL(signedSegmentUrl ?? '').origin).toBe(runtime.objectStorageConfig.publicUrl);
    const segmentResponse = await fetch(signedSegmentUrl ?? '');
    expect(segmentResponse.status).toBe(200);
    expect(Buffer.from(await segmentResponse.arrayBuffer())).toEqual(active.segmentBody);
    const thumbnailRedirect = await request(app).get(thumbnailPath).redirects(0).expect(307);
    const signedThumbnailUrl = thumbnailRedirect.headers.location as string | undefined;

    expect(thumbnailRedirect.headers['cache-control']).toBe('no-store');
    expect(signedThumbnailUrl).toBeDefined();
    const thumbnailResponse = await fetch(signedThumbnailUrl ?? '');
    expect(thumbnailResponse.status).toBe(200);
    expect(Buffer.from(await thumbnailResponse.arrayBuffer())).toEqual(
      Buffer.from('test thumbnail bytes'),
    );

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const unavailableResponses = await Promise.all([
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${otherVideoGeneration.generationId}/720p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/720p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${writing.generationId}/480p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${retired.generationId}/480p/index.m3u8`,
      ),
      request(app).get(
        `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/segment-99999.ts`,
      ),
    ]);

    for (const response of unavailableResponses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFoundBody);
    }

    const retiringRenditionPath = `/videos/${firstVideo.video.publicId}/hls/${retiring.generationId}/480p/index.m3u8`;
    await request(app).get(retiringRenditionPath).expect(200).expect('Cache-Control', 'no-cache');

    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { role: 'moderator' },
    });
    await request(app)
      .post(`/moderation/videos/${firstVideo.video.id}/moderation`)
      .set('Authorization', `Bearer ${owner.sessionKey}`)
      .send({ decision: 'rejected' })
      .expect(200);
    await request(app).get(masterPath).expect(200);
    await request(app).get(thumbnailPath).redirects(0).expect(307);

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: {
        moderationStatus: 'pending',
        processingStatus: 'processing',
      },
    });
    const processingResponse = await request(app).get(masterPath);
    expect(processingResponse.status).toBe(404);
    expect(processingResponse.body).toEqual(notFoundBody);
    await request(app).get(thumbnailPath).expect(404).expect(notFoundBody);

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: { processingStatus: 'ready' },
    });
    const invalidPaths = [
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480P/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/${encodeURIComponent('../480p')}/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/${encodeURIComponent('/480p')}/index.m3u8`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/segment-0000.ts`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('../segment-00000.ts')}`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('/segment-00000.ts')}`,
      `/videos/${firstVideo.video.publicId}/hls/${active.generationId}/480p/segments/${encodeURIComponent('C:\\segment-00000.ts')}`,
    ];

    for (const path of invalidPaths) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
    }

    await runtime.prisma.video.update({
      where: { id: firstVideo.video.id },
      data: { visibility: 'public' },
    });
    await request(app).get(masterPath).expect(200);
  });

  test('expires generation-qualified HLS after a controlled one-hour retirement window', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'hls-retention@example.com',
      username: 'hls_retention',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'HLS retirement clock',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('source for controlled HLS retirement'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const storedJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: source.uploadSession.objectKey,
      },
      select: {
        id: true,
      },
    });
    const generationA = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('generation A segment'),
      sourceUploadSessionId: source.uploadSession.id,
      state: 'active',
      transcodeJobId: storedJob.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generationA.generationId,
      manifest: generationA.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: created.video.id,
    });
    await runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: generationA.manifest.thumbnail.objectKey,
      body: Buffer.from('generation A thumbnail'),
      contentType: 'image/webp',
    });
    await runtime.prisma.video.update({
      where: { id: created.video.id },
      data: {
        activeArtifactGenerationId: generationA.generationId,
        hlsMasterObjectKey: generationA.manifest.master.objectKey,
        thumbnailObjectKey: generationA.manifest.thumbnail.objectKey,
        processingStatus: 'ready',
      },
    });

    const masterPath = `/videos/${created.video.publicId}/hls/master.m3u8`;
    const oldRenditionPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/index.m3u8`;
    const oldSegmentPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/segments/${generationA.segmentName}`;
    const masterA = await request(app).get(masterPath).expect(200);

    expect(masterA.text).toContain(oldRenditionPath);

    let controlledNow = new Date();
    const claimedJob = await claimNextVideoTranscodeJob({
      prisma: runtime.prisma,
      clock: { now: () => controlledNow },
    });

    expect(claimedJob?.id).toBe(storedJob.id);

    if (!claimedJob) {
      throw new Error('Expected the source transcode job to be claimed');
    }

    const generationB = await prepareHlsGenerationForPublication(runtime, {
      job: claimedJob,
      segmentBody: Buffer.from('generation B segment'),
      sourceUploadSessionId: source.uploadSession.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await publishVideoArtifactGeneration(
      {
        prisma: runtime.prisma,
        clock: { now: () => controlledNow },
      },
      {
        generation: generationB.generation,
        job: claimedJob,
        manifest: generationB.manifest,
        probe: {
          width: 854,
          height: 480,
          durationSeconds: 6,
          hasAudio: true,
        },
      },
    );

    const retirementTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        generation: generationA.generationId,
      },
      select: {
        goal: true,
        quiescenceNotBefore: true,
        state: true,
      },
    });
    expect(retirementTargets).toHaveLength(2);
    expect(
      retirementTargets.every(
        (target) =>
          target.goal === 'absent' &&
          target.state === 'quiescing' &&
          target.quiescenceNotBefore?.getTime() === controlledNow.getTime() + HOUR_MS,
      ),
    ).toBe(true);

    controlledNow = new Date(controlledNow.getTime() + HOUR_MS + 1);
    const controlledExternalResources = createExternalResourceReconciler({
      prisma: runtime.prisma,
      objectStorage: runtime.videoObjectStorage,
      clock: { now: () => controlledNow },
      logger: testLogger,
    });
    const controlledVideosService = createIntegrationVideosService(
      runtime.prisma,
      runtime.videoObjectStorage,
      controlledExternalResources,
      { now: () => controlledNow },
    );
    await expect(
      controlledVideosService.reconcilePendingExternalResources(),
    ).resolves.toMatchObject({
      confirmed: 2,
      failed: 0,
    });
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: generationA.generationId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'retired' });

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const [oldRendition, oldSegment] = await Promise.all([
      request(app).get(oldRenditionPath),
      request(app).get(oldSegmentPath).redirects(0),
    ]);

    expect(oldRendition.status).toBe(404);
    expect(oldRendition.body).toEqual(notFoundBody);
    expect(oldSegment.status).toBe(404);
    expect(oldSegment.body).toEqual(notFoundBody);
    await request(app)
      .get(masterPath)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(
          `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/index.m3u8`,
        );
      });
  });

  test('interrupts HLS after a real source replacement until its generation is published', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'hls-source-replacement@example.com',
      username: 'hls_source_replace',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'HLS source replacement',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const sourceA = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('first source for HLS replacement'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const firstJob = await runtime.prisma.videoTranscodeJob.findFirstOrThrow({
      where: {
        videoId: created.video.id,
        sourceObjectKey: sourceA.uploadSession.objectKey,
      },
      select: { id: true },
    });
    const generationA = await seedHlsGeneration(runtime, {
      segmentBody: Buffer.from('first generation segment'),
      sourceUploadSessionId: sourceA.uploadSession.id,
      state: 'active',
      transcodeJobId: firstJob.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await reserveHlsArtifactTargets(runtime, {
      generationId: generationA.generationId,
      manifest: generationA.manifest,
      state: 'confirmed_present',
      userId: owner.userId,
      videoId: created.video.id,
    });
    await runtime.videoObjectStorage.putObject({
      bucket: VIDEO_OBJECT_STORAGE_BUCKET,
      objectKey: generationA.manifest.thumbnail.objectKey,
      body: Buffer.from('first generation thumbnail'),
      contentType: 'image/webp',
    });
    await runtime.prisma.$transaction([
      runtime.prisma.videoTranscodeJob.update({
        where: { id: firstJob.id },
        data: {
          status: 'completed',
          attempts: 1,
          completedAt: new Date(),
        },
      }),
      runtime.prisma.video.update({
        where: { id: created.video.id },
        data: {
          activeArtifactGenerationId: generationA.generationId,
          hlsMasterObjectKey: generationA.manifest.master.objectKey,
          thumbnailObjectKey: generationA.manifest.thumbnail.objectKey,
          processingStatus: 'ready',
        },
      }),
    ]);

    const masterPath = `/videos/${created.video.publicId}/hls/master.m3u8`;
    const oldRenditionPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/index.m3u8`;
    const oldSegmentPath = `/videos/${created.video.publicId}/hls/${generationA.generationId}/480p/segments/${generationA.segmentName}`;
    await request(app).get(masterPath).expect(200);
    await request(app).get(oldRenditionPath).expect(200);
    await request(app).get(oldSegmentPath).redirects(0).expect(307);

    const sourceB = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('replacement source with different bytes'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    await expect(
      runtime.prisma.video.findUniqueOrThrow({
        where: { id: created.video.id },
        select: {
          activeArtifactGenerationId: true,
          processingStatus: true,
          sourceUploadSessionId: true,
        },
      }),
    ).resolves.toEqual({
      activeArtifactGenerationId: generationA.generationId,
      processingStatus: 'queued',
      sourceUploadSessionId: sourceB.uploadSession.id,
    });

    const notFoundBody = {
      error: 'NotFound',
      message: 'Video not found',
    };
    const unavailableDuringReplacement = await Promise.all([
      request(app).get(masterPath),
      request(app).get(oldRenditionPath),
      request(app).get(oldSegmentPath).redirects(0),
    ]);

    for (const response of unavailableDuringReplacement) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFoundBody);
    }

    const publicationAt = new Date();
    const claimedReplacementJob = await claimNextVideoTranscodeJob({
      prisma: runtime.prisma,
      clock: { now: () => publicationAt },
    });

    expect(claimedReplacementJob?.sourceObjectKey).toBe(sourceB.uploadSession.objectKey);

    if (!claimedReplacementJob) {
      throw new Error('Expected the replacement source transcode job to be claimed');
    }

    const generationB = await prepareHlsGenerationForPublication(runtime, {
      job: claimedReplacementJob,
      segmentBody: Buffer.from('replacement generation segment'),
      sourceUploadSessionId: sourceB.uploadSession.id,
      userId: owner.userId,
      videoId: created.video.id,
    });
    await publishVideoArtifactGeneration(
      {
        prisma: runtime.prisma,
        clock: { now: () => publicationAt },
      },
      {
        generation: generationB.generation,
        job: claimedReplacementJob,
        manifest: generationB.manifest,
        probe: {
          width: 854,
          height: 480,
          durationSeconds: 6,
          hasAudio: true,
        },
      },
    );

    const newRenditionPath = `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/index.m3u8`;
    const newSegmentPath = `/videos/${created.video.publicId}/hls/${generationB.generationId}/480p/segments/${generationB.segmentName}`;
    await request(app)
      .get(masterPath)
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain(newRenditionPath);
      });
    await request(app).get(newRenditionPath).expect(200);
    await request(app).get(newSegmentPath).redirects(0).expect(307);
    await expect(
      runtime.prisma.videoArtifactGeneration.findUniqueOrThrow({
        where: { id: generationA.generationId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'retiring' });
  });

  test('stores uploaded profile media in MinIO and serves it through signed profile URLs', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const { sessionKey, userId } = await createVerifiedSession(runtime, {
      email: 'minio-media@example.com',
      username: 'minio_media_user',
    });
    const avatarInput = await createPng();

    const uploadResponse = await request(app)
      .put('/auth/me/avatar')
      .set('Authorization', `Bearer ${sessionKey}`)
      .attach('avatar', avatarInput, {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(200);

    expect(uploadResponse.body).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: expect.any(String),
        mimeType: 'image/webp',
        sizeBytes: expect.any(Number),
        width: 512,
        height: 512,
        updatedAt: expect.any(String),
      },
    });
    const uploadedAvatar = uploadResponse.body.avatar as {
      sizeBytes: number;
      url: string;
    };
    const uploadUrl = new URL(uploadedAvatar.url);
    expect(uploadUrl.origin).toBe(runtime.objectStorageConfig.publicUrl);
    expect(uploadUrl.pathname).toMatch(
      new RegExp(`^/${OBJECT_STORAGE_BUCKET}/users/[0-9a-f-]+/avatar/[0-9a-f-]+\\.webp$`),
    );
    expect(uploadUrl.search).not.toBe('');

    const asset = await runtime.prisma.userMediaAsset.findFirstOrThrow({
      where: {
        userId,
        kind: 'avatar',
      },
      select: {
        bucket: true,
        externalResourceTargetId: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
      },
    });

    expect(asset).toEqual({
      bucket: OBJECT_STORAGE_BUCKET,
      externalResourceTargetId: expect.any(String),
      objectKey: expect.stringMatching(/^users\/[0-9a-f-]+\/avatar\/[0-9a-f-]+\.webp$/),
      mimeType: 'image/webp',
      sizeBytes: uploadedAvatar.sizeBytes,
      width: 512,
      height: 512,
    });

    await expectIntegrationReadinessOk(app);

    const profileResponse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${sessionKey}`)
      .expect(200);
    const avatarUrl = profileResponse.body.user.avatarUrl;
    expect(avatarUrl).toEqual(
      expect.stringContaining(`/${OBJECT_STORAGE_BUCKET}/${asset.objectKey}?`),
    );

    const mediaResponse = await fetch(avatarUrl);
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get('content-type')).toContain('image/webp');

    const mediaBody = Buffer.from(await mediaResponse.arrayBuffer());
    expect(mediaBody.length).toBe(asset.sizeBytes);
    const metadata = await sharp(mediaBody).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);

    const replacementInput = await createPng(900, 700);
    await runtime.authService.uploadAvatar({
      userId,
      file: {
        buffer: replacementInput,
        size: replacementInput.length,
      },
    });
    const replacement = await runtime.prisma.userMediaAsset.findFirstOrThrow({
      where: {
        userId,
        kind: 'avatar',
      },
      select: {
        externalResourceTargetId: true,
        objectKey: true,
      },
    });
    const oldTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: { id: asset.externalResourceTargetId },
    });

    expect(replacement.objectKey).not.toBe(asset.objectKey);
    expect(oldTarget).toMatchObject({
      bucket: OBJECT_STORAGE_BUCKET,
      selector: asset.objectKey,
      selectorKind: 'exact',
      role: 'user_media',
      goal: 'absent',
      state: 'quiescing',
    });
    await expect(
      runtime.objectStorage.headObject({
        bucket: asset.bucket,
        objectKey: asset.objectKey,
      }),
    ).resolves.not.toBeNull();

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: oldTarget.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 0,
      confirmed: 0,
    });
    await expect(runtime.authService.reconcileUserMediaTargets({})).resolves.toMatchObject({
      mediaTargetsConfirmed: 1,
      mediaTargetsFailed: 0,
    });
    await expect(
      runtime.objectStorage.headObject({
        bucket: asset.bucket,
        objectKey: asset.objectKey,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: oldTarget.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'confirmed_absent' });
  });

  test('serializes two concurrent user-media replacements onto one current asset', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'concurrent-media@example.com',
      username: 'concurrent_media',
    });
    const [firstAvatar, secondAvatar] = await Promise.all([
      createPng(800, 600),
      createPng(900, 700),
    ]);

    await Promise.all([
      runtime.authService.uploadAvatar({
        userId: owner.userId,
        file: {
          buffer: firstAvatar,
          size: firstAvatar.length,
        },
      }),
      runtime.authService.uploadAvatar({
        userId: owner.userId,
        file: {
          buffer: secondAvatar,
          size: secondAvatar.length,
        },
      }),
    ]);

    const assets = await runtime.prisma.userMediaAsset.findMany({
      where: {
        userId: owner.userId,
        kind: 'avatar',
      },
      select: {
        externalResourceTargetId: true,
      },
    });
    const targets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        userId: owner.userId,
        role: 'user_media',
      },
      select: {
        goal: true,
        id: true,
        quiescenceNotBefore: true,
        state: true,
      },
    });

    expect(assets).toHaveLength(1);
    expect(targets).toHaveLength(2);
    const currentTarget = targets.find(({ id }) => id === assets[0]?.externalResourceTargetId);
    const replacedTarget = targets.find(({ id }) => id !== assets[0]?.externalResourceTargetId);

    expect(currentTarget).toMatchObject({
      goal: 'present',
      quiescenceNotBefore: null,
      state: 'confirmed_present',
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      quiescenceNotBefore: expect.any(Date),
      state: 'quiescing',
    });
  });

  test('deletes an account while retaining durable cleanup for media, sources, and generation prefixes', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'account-cleanup@example.com',
      username: 'account_cleanup',
    });
    const created = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Account cleanup resources',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const source = await uploadVideoSource(runtime.videosService, {
      body: Buffer.from('account cleanup source'),
      userId: owner.userId,
      videoId: created.video.id,
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: avatar,
        size: avatar.length,
      },
    });

    const [sourceSession, transcodeJob, mediaAsset] = await Promise.all([
      runtime.prisma.videoUploadSession.findUniqueOrThrow({
        where: { id: source.uploadSession.id },
        select: {
          externalResourceTargetId: true,
          objectKey: true,
        },
      }),
      runtime.prisma.videoTranscodeJob.findFirstOrThrow({
        where: { videoId: created.video.id },
        select: { id: true },
      }),
      runtime.prisma.userMediaAsset.findFirstOrThrow({
        where: {
          userId: owner.userId,
          kind: 'avatar',
        },
        select: {
          bucket: true,
          externalResourceTargetId: true,
          objectKey: true,
        },
      }),
    ]);
    const generation = randomUUID();
    const generationPrefix = `${owner.userId}/${created.video.id}/generations/${generation}/hls/`;
    const thumbnailPrefix = `${owner.userId}/${created.video.id}/generations/${generation}/thumbnail/`;
    const masterObjectKey = `${generationPrefix}master.m3u8`;
    const segmentObjectKey = `${generationPrefix}480p/segment-000.ts`;
    const thumbnailObjectKey = `${thumbnailPrefix}poster.webp`;

    await Promise.all([
      runtime.videoObjectStorage.putObject({
        objectKey: masterObjectKey,
        body: Buffer.from('#EXTM3U'),
        contentType: 'application/vnd.apple.mpegurl',
      }),
      runtime.videoObjectStorage.putObject({
        objectKey: segmentObjectKey,
        body: Buffer.from('segment'),
        contentType: 'video/mp2t',
      }),
      runtime.videoObjectStorage.putObject({
        objectKey: thumbnailObjectKey,
        body: Buffer.from('thumbnail'),
        contentType: 'image/webp',
      }),
    ]);

    const artifactGeneration = await runtime.prisma.videoArtifactGeneration.create({
      data: {
        id: generation,
        videoId: created.video.id,
        sourceUploadSessionId: source.uploadSession.id,
        transcodeJobId: transcodeJob.id,
        executionId: randomUUID(),
        bucket: VIDEO_OBJECT_STORAGE_BUCKET,
        state: 'active',
        hlsMasterObjectKey: masterObjectKey,
        thumbnailObjectKey,
        activatedAt: new Date(),
      },
      select: { id: true },
    });
    await Promise.all([
      runtime.prisma.video.update({
        where: { id: created.video.id },
        data: {
          activeArtifactGenerationId: artifactGeneration.id,
          hlsMasterObjectKey: masterObjectKey,
          thumbnailObjectKey,
          processingStatus: 'ready',
        },
      }),
      runtime.prisma.externalResourceTarget.createMany({
        data: [
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: generationPrefix,
            selectorKind: 'prefix',
            role: 'hls_artifacts',
            generation,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'confirmed_present',
          },
          {
            userId: owner.userId,
            videoId: created.video.id,
            bucket: VIDEO_OBJECT_STORAGE_BUCKET,
            selector: thumbnailPrefix,
            selectorKind: 'prefix',
            role: 'thumbnail_prefix',
            generation,
            expectedSizeBytes: null,
            mayHaveMultipartUpload: false,
            goal: 'present',
            state: 'confirmed_present',
          },
        ],
      }),
    ]);

    const deletion = await runtime.authService.deleteAccount({
      userId: owner.userId,
      currentPassword: INITIAL_PASSWORD,
    });

    expect(deletion).toMatchObject({
      mediaCleanupQueued: 1,
      externalCleanupQueued: 4,
    });
    await expect(
      runtime.prisma.user.findUnique({ where: { id: owner.userId } }),
    ).resolves.toBeNull();
    await expect(runtime.prisma.video.count({ where: { ownerId: owner.userId } })).resolves.toBe(0);
    await expect(
      runtime.prisma.videoArtifactGeneration.count({
        where: { id: artifactGeneration.id },
      }),
    ).resolves.toBe(0);

    const queuedTargets = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: {
        id: true,
        role: true,
        state: true,
      },
      orderBy: { role: 'asc' },
    });
    expect(queuedTargets).toHaveLength(4);
    expect(queuedTargets.every(({ state }) => state === 'quiescing')).toBe(true);
    expect(queuedTargets.map(({ role }) => role).sort()).toEqual([
      'hls_artifacts',
      'source',
      'thumbnail_prefix',
      'user_media',
    ]);

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.updateMany({
      where: { userId: owner.userId },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(
      runtime.externalResources.reconcileDue({
        roles: ['source', 'hls_artifacts', 'thumbnail_prefix', 'user_media'],
        limit: 10,
      }),
    ).resolves.toMatchObject({
      claimed: 4,
      confirmed: 4,
      failed: 0,
    });

    await expect(
      runtime.prisma.externalResourceTarget.count({
        where: {
          userId: owner.userId,
          state: { not: 'confirmed_absent' },
        },
      }),
    ).resolves.toBe(0);
    await Promise.all([
      expect(
        runtime.videoObjectStorage.headObject({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          objectKey: sourceSession.objectKey,
        }),
      ).resolves.toBeNull(),
      expect(
        runtime.objectStorage.headObject({
          bucket: mediaAsset.bucket,
          objectKey: mediaAsset.objectKey,
        }),
      ).resolves.toBeNull(),
      expect(
        runtime.videoObjectStorage.listObjects({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          prefix: generationPrefix,
          limit: 1,
        }),
      ).resolves.toEqual({ objects: [], truncated: false }),
      expect(
        runtime.videoObjectStorage.listObjects({
          bucket: VIDEO_OBJECT_STORAGE_BUCKET,
          prefix: thumbnailPrefix,
          limit: 1,
        }),
      ).resolves.toEqual({ objects: [], truncated: false }),
    ]);
    expect(queuedTargets.map(({ id }) => id)).toContain(sourceSession.externalResourceTargetId);
    expect(queuedTargets.map(({ id }) => id)).toContain(mediaAsset.externalResourceTargetId);
  });

  test('keeps concurrent account deletions idempotent without creating cleanup targets', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'concurrent-account-delete@example.com',
      username: 'concurrent_delete',
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: avatar,
        size: avatar.length,
      },
    });
    const targetsBefore = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let arrivals = 0;
    let release: (() => void) | null = null;
    const bothReauthenticated = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const deletionService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.externalResources,
      {
        afterPasswordCompare: async () => {
          arrivals += 1;

          if (arrivals === 2) {
            release?.();
          }

          await bothReauthenticated;
        },
      },
    );

    const deletions = await Promise.all([
      deletionService.deleteAccount({
        userId: owner.userId,
        currentPassword: INITIAL_PASSWORD,
      }),
      deletionService.deleteAccount({
        userId: owner.userId,
        currentPassword: INITIAL_PASSWORD,
      }),
    ]);

    expect(deletions).toEqual([
      expect.objectContaining({
        externalCleanupQueued: 1,
        mediaCleanupQueued: 1,
      }),
      expect.objectContaining({
        externalCleanupQueued: 1,
        mediaCleanupQueued: 1,
      }),
    ]);
    await expect(
      runtime.prisma.user.findUnique({
        where: { id: owner.userId },
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.userMediaAsset.count({
        where: { userId: owner.userId },
      }),
    ).resolves.toBe(0);

    const targetsAfter = await runtime.prisma.externalResourceTarget.findMany({
      where: { userId: owner.userId },
      select: {
        goal: true,
        id: true,
        quiescenceNotBefore: true,
        state: true,
      },
      orderBy: { id: 'asc' },
    });

    expect(targetsAfter.map(({ id }) => ({ id }))).toEqual(targetsBefore);
    expect(targetsAfter).toEqual([
      expect.objectContaining({
        goal: 'absent',
        quiescenceNotBefore: expect.any(Date),
        state: 'quiescing',
      }),
    ]);
  });

  test('shares auth rate limits across two app instances through Redis', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const secondRedisClient = createRedisClient(runtime.redisUrl, testLogger);
    await connectRedisClient(secondRedisClient);

    try {
      const firstApp = await createIntegrationApp(runtime);
      const secondRuntime = {
        ...runtime,
        redisClient: secondRedisClient,
      };
      const secondApp = await createIntegrationApp(secondRuntime);

      for (let index = 0; index < 10; index += 1) {
        await request(firstApp).post('/auth/login').send({}).expect(400);
      }

      for (let index = 0; index < 10; index += 1) {
        await request(secondApp).post('/auth/login').send({}).expect(400);
      }

      await request(secondApp).post('/auth/login').send({}).expect(429).expect({
        error: 'TooManyRequests',
        message: AUTH_RATE_LIMIT_MESSAGE,
      });
    } finally {
      await closeRedisClient(secondRedisClient, testLogger);
    }
  });

  test('rate limits login attempts by normalized identifier', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const email = 'login-limit@example.com';

    await runtime.authService.register({
      email,
      username: 'login_limit_user',
      password: INITIAL_PASSWORD,
    });

    const verificationEmail = runtime.delivered.verification.at(-1);
    await runtime.authService.verifyEmail({
      email,
      code: verificationEmail?.token ?? '',
    });

    for (let index = 0; index < 5; index += 1) {
      await request(app)
        .post('/auth/login')
        .send({
          emailOrUsername: ` ${email.toUpperCase()} `,
          password: 'WrongPassword1!',
        })
        .expect(401)
        .expect({
          error: 'Unauthorized',
          message: INVALID_CREDENTIALS_MESSAGE,
        });
    }

    await request(app)
      .post('/auth/login')
      .send({
        emailOrUsername: email,
        password: 'WrongPassword1!',
      })
      .expect(429)
      .expect({
        error: 'TooManyRequests',
        message: LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE,
      });
  });

  test('rate limits registration attempts by normalized email', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const email = 'registration-limit@example.com';

    await request(app)
      .post('/auth/register')
      .send({
        email: ` ${email.toUpperCase()} `,
        username: 'registration_limit_0',
        password: INITIAL_PASSWORD,
      })
      .expect(201)
      .expect({
        message: REGISTER_SUCCESS_MESSAGE,
      });

    for (let index = 1; index < REGISTRATION_IDENTIFIER_RATE_LIMIT_MAX; index += 1) {
      await request(app)
        .post('/auth/register')
        .send({
          email,
          username: `registration_limit_${index}`,
          password: INITIAL_PASSWORD,
        })
        .expect(409);
    }

    await request(app)
      .post('/auth/register')
      .send({
        email,
        username: 'registration_final',
        password: INITIAL_PASSWORD,
      })
      .expect(429)
      .expect({
        error: 'TooManyRequests',
        message: REGISTRATION_IDENTIFIER_RATE_LIMIT_MESSAGE,
      });
  });

  test('keeps password reset responses generic during email cooldowns', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const email = 'reset-cooldown@example.com';
    const expectedResponse = {
      message: RESET_PASSWORD_EMAIL_MESSAGE,
    };

    await runtime.authService.register({
      email,
      username: 'reset_cooldown_user',
      password: INITIAL_PASSWORD,
    });

    const verificationEmail = runtime.delivered.verification.at(-1);
    await runtime.authService.verifyEmail({
      email,
      code: verificationEmail?.token ?? '',
    });
    runtime.delivered.passwordReset = [];

    await request(app)
      .post('/auth/forgot-password')
      .send({ email: ` ${email.toUpperCase()} ` })
      .expect(200)
      .expect(expectedResponse);

    expect(runtime.delivered.passwordReset).toHaveLength(1);

    await request(app)
      .post('/auth/forgot-password')
      .send({ email })
      .expect(200)
      .expect(expectedResponse);

    expect(runtime.delivered.passwordReset).toHaveLength(1);
  });

  test('keeps verification resend responses generic during email cooldowns', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const email = 'verification-cooldown@example.com';
    const expectedResponse = {
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    };

    await runtime.authService.register({
      email,
      username: 'verify_cooldown',
      password: INITIAL_PASSWORD,
    });
    runtime.delivered.verification = [];

    await request(app)
      .post('/auth/resend-verification')
      .send({ email: ` ${email.toUpperCase()} ` })
      .expect(200)
      .expect(expectedResponse);

    expect(runtime.delivered.verification).toHaveLength(1);

    await request(app)
      .post('/auth/resend-verification')
      .send({ email })
      .expect(200)
      .expect(expectedResponse);

    expect(runtime.delivered.verification).toHaveLength(1);
  });
});
