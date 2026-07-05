import { execFile } from 'node:child_process';
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
import { createUserMediaProcessor } from '../../src/services/userMedia/userMedia.processor.js';
import {
  generateSixDigitCode,
  generateToken,
  hashAuthCode,
  hashToken,
} from '../../src/lib/crypto.js';
import {
  createMinioClient,
  createObjectStorage,
  type ObjectStorage,
} from '../../src/lib/objectStorage.js';
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
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  REGISTRATION_IDENTIFIER_RATE_LIMIT_MAX,
  SESSION_TTL_MS,
} from '../../src/config/constants.js';
import type { AuthPorts } from '../../src/services/auth.types.js';
import type { AdminPorts } from '../../src/services/admin.types.js';
import type { Redis } from 'ioredis';
import type { ObjectStorageConfig } from '../../src/config/env.parsers.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

const POSTGRES_PORT = 5432;
const REDIS_PORT = 6379;
const MINIO_PORT = 9000;
const OBJECT_STORAGE_BUCKET = 'fairplay-integration-media';
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
  adminService: AdminPorts;
  authService: AuthPorts;
  delivered: {
    verification: DeliveredEmail[];
    passwordReset: DeliveredEmail[];
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

const buildObjectStorageConfig = (container: StartedTestContainer): ObjectStorageConfig => {
  const origin = `http://${container.getHost()}:${container.getMappedPort(MINIO_PORT)}`;

  return {
    endpoint: origin,
    publicUrl: origin,
    region: 'us-east-1',
    bucket: OBJECT_STORAGE_BUCKET,
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

const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

const createIntegrationAuthService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  delivered: TestRuntime['delivered'],
): AuthPorts =>
  createAuthService({
    prisma,
    isUniqueError: (err): boolean =>
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    hasher: {
      hash: (password, rounds) => bcrypt.hash(password, rounds),
      compare: (password, hash) => bcrypt.compare(password, hash),
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
): AdminPorts =>
  createAdminService({
    prisma,
    objectStorage,
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
      redisClient: runtime.redisClient,
      readinessChecks: {
        database: async () => {
          await runtime.prisma.$queryRaw`SELECT 1`;
        },
        redis: async () => {
          await runtime.redisClient.ping();
        },
        objectStorage: async () => {
          await runtime.objectStorage.checkReady();
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

    await runPrismaMigrations(databaseUrl);

    const prisma = createPrismaClient(databaseUrl);
    const redisClient = createRedisClient(redisUrl, testLogger);
    const objectStorage = createObjectStorage(
      objectStorageConfig,
      createMinioClient(objectStorageConfig),
      testLogger,
    );
    await connectRedisClient(redisClient);

    const delivered = {
      verification: [],
      passwordReset: [],
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
      adminService: createIntegrationAdminService(prisma, objectStorage),
      authService: createIntegrationAuthService(prisma, objectStorage, delivered),
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
  await runtime.prisma.userMediaDeletionJob.deleteMany();
  await runtime.prisma.passwordResetToken.deleteMany();
  await runtime.prisma.emailVerificationToken.deleteMany();
  await runtime.prisma.session.deleteMany();
  await runtime.prisma.user.deleteMany();
  await runtime.redisClient.call('flushdb');
  runtime.delivered.verification = [];
  runtime.delivered.passwordReset = [];
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
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
      },
    });

    expect(asset).toEqual({
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
