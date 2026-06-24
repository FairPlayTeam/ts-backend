import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { createApp } from '../../src/app.js';
import { createAuthService } from '../../src/services/auth.service.js';
import { generateSixDigitCode, generateToken, hashToken } from '../../src/lib/crypto.js';
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
import type { AuthService } from '../../src/services/auth.types.js';
import type { Redis } from 'ioredis';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

const POSTGRES_PORT = 5432;
const REDIS_PORT = 6379;
const TEST_EMAIL = 'integration@example.com';
const TEST_USERNAME = 'integration_user';
const INITIAL_PASSWORD = 'Password1!';
const NEXT_PASSWORD = 'NewPassword1!';

type DeliveredEmail = {
  email: string;
  token: string;
};

type TestRuntime = {
  databaseUrl: string;
  redisUrl: string;
  postgresContainer: StartedTestContainer;
  redisContainer: StartedTestContainer;
  prisma: PrismaClient;
  redisClient: Redis;
  authService: AuthService;
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

const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

const createIntegrationAuthService = (
  prisma: PrismaClient,
  delivered: TestRuntime['delivered'],
): AuthService =>
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
      hash: (token) => hashToken(token),
    },
    mailer: {
      sendVerificationEmail: async (email, code) => {
        delivered.verification.push({ email, token: code });
      },
      sendPasswordResetEmail: async (email, code) => {
        delivered.passwordReset.push({ email, token: code });
      },
    },
    objectStorage: {
      putObject: async () => undefined,
      deleteObject: async () => undefined,
      getSignedUrl: async () =>
        'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
    },
    userMediaProcessor: {
      process: async () => ({
        buffer: Buffer.from('avatar'),
        mimeType: 'image/webp',
        sizeBytes: 6,
        width: 512,
        height: 512,
      }),
    },
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

const createIntegrationApp = async (runtime: TestRuntime) =>
  createApp(
    {
      allowedOrigins: [],
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
      baseUrl: 'http://localhost:3000',
      isProduction: false,
      jsonBodyLimitBytes: 1024 * 1024,
      rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
      trustProxy: false,
    },
    {
      authService: runtime.authService,
      redisClient: runtime.redisClient,
      readinessChecks: {
        database: async () => {
          await runtime.prisma.$queryRaw`SELECT 1`;
        },
        redis: async () => {
          await runtime.redisClient.ping();
        },
      },
    },
  );

const startRuntime = async (): Promise<TestRuntime> => {
  let postgresContainer: StartedTestContainer | null = null;
  let redisContainer: StartedTestContainer | null = null;

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

    const databaseUrl = buildDatabaseUrl(postgresContainer);
    const redisUrl = buildRedisUrl(redisContainer);

    await runPrismaMigrations(databaseUrl);

    const prisma = createPrismaClient(databaseUrl);
    const redisClient = createRedisClient(redisUrl, testLogger);
    await connectRedisClient(redisClient);

    const delivered = {
      verification: [],
      passwordReset: [],
    };

    return {
      databaseUrl,
      redisUrl,
      postgresContainer,
      redisContainer,
      prisma,
      redisClient,
      authService: createIntegrationAuthService(prisma, delivered),
      delivered,
    };
  } catch (error) {
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
      hashToken(`${storedVerificationToken.userId}:${verificationEmail?.token ?? ''}`),
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
      hashToken(`${storedPasswordResetToken.userId}:${resetEmail?.token ?? ''}`),
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

  test('reports readiness against the real database and redis clients', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);

    await request(app)
      .get('/health/ready')
      .expect(200)
      .expect({
        status: 'ok',
        services: {
          database: 'ok',
          redis: 'ok',
        },
      });
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
