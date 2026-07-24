import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { createApp } from '../../src/app.js';
import { createAdminService } from '../../src/services/admin.service.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { createProfilesService } from '../../src/services/profiles.service.js';
import { createVideosService } from '../../src/services/videos.service.js';
import { createVideoPublicId } from '../../src/services/videos/videoPublicId.js';
import {
  buildVideoArtifactManifest,
  videoOriginalKey,
} from '../../src/services/videos/videoObjectKeys.js';
import {
  claimNextVideoTranscodeJob,
  createVideoTranscodeRunner,
  publishVideoArtifactGeneration,
  VideoTranscodeOwnershipLostError,
  type ClaimedVideoTranscodeJob,
} from '../../src/services/videos/videoTranscodeRunner.js';
import { createUserMediaProcessor } from '../../src/services/userMedia/userMedia.processor.js';
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
  VideoUploadSizeMismatchError,
} from '../../src/services/videos.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
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
): Promise<string> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'fairplay-integration-object-'));
  const destinationPath = resolve(directory, 'object');

  try {
    await storage.downloadObject({
      bucket,
      objectKey,
      destinationPath,
    });

    return await readFile(destinationPath, 'utf8');
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
      now: () => new Date(),
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
    publicIds?: string[];
    userStorageQuotaBytes?: number;
  } = {},
): VideosService =>
  createVideosService({
    prisma,
    objectStorage,
    externalResources,
    clock: {
      now: () => new Date(),
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
  }: {
    body: Buffer;
    userId: string;
    videoId: string;
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
      license: 'all_rights_reserved',
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

  test('takes over a stale transcode into a complete generation and retires the previous generation atomically', async () => {
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
