import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { inject } from 'vitest';

import { createApp } from '../../../src/app.js';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  SESSION_TTL_MS,
} from '../../../src/config/constants.js';
import {
  generateSixDigitCode,
  generateToken,
  hashAuthCode,
  hashToken,
} from '../../../src/lib/crypto.js';
import {
  createMinioClient,
  createMinioSigningClient,
  createObjectStorage,
  type ObjectStorage,
} from '../../../src/lib/objectStorage.js';
import { closeRedisClient, connectRedisClient, createRedisClient } from '../../../src/lib/redis.js';
import { createAdminService } from '../../../src/services/admin.service.js';
import { createAuthService } from '../../../src/services/auth.service.js';
import {
  createExternalResourceReconciler,
  type ExternalResourceReconciler,
} from '../../../src/services/externalResources.js';
import { createProfilesService } from '../../../src/services/profiles.service.js';
import { createUserMediaProcessor } from '../../../src/services/userMedia/userMedia.processor.js';
import { createVideosService } from '../../../src/services/videos.service.js';
import { createVideoPublicId } from '../../../src/services/videos/videoPublicId.js';
import type { AdminPorts } from '../../../src/services/admin.types.js';
import type { AuthPorts } from '../../../src/services/auth.types.js';
import type { ProfilesPorts } from '../../../src/services/profiles.types.js';
import type { VideosService } from '../../../src/services/videos.types.js';
import type { ObjectStorageConfig } from '../../../src/config/env.parsers.js';
import type { Redis } from 'ioredis';

export const PROFILE_MEDIA_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const AUTH_CODE_PEPPER = 'integration-auth-code-pepper-change-me';

type DeliveredEmail = {
  email: string;
  token: string;
};

type DeliveredBanEmail = {
  email: string;
  reason: string;
};

export type TestRuntime = {
  databaseUrl: string;
  redisUrl: string;
  objectStorageConfig: ObjectStorageConfig;
  postgresContainerId: string;
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

export const testLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const createPrismaClient = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

export const createIntegrationAuthService = (
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

export const createIntegrationAdminService = (
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

export const createIntegrationProfilesService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
): ProfilesPorts =>
  createProfilesService({
    prisma,
    objectStorage,
  });

export const createIntegrationVideosService = (
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

export const createIntegrationApp = async (runtime: TestRuntime) =>
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

export const expectIntegrationReadinessOk = async (
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

export const startRuntime = async (): Promise<TestRuntime> => {
  const infrastructure = inject('integrationInfrastructure');
  const prisma = createPrismaClient(infrastructure.databaseUrl);
  const redisClient = createRedisClient(infrastructure.redisUrl, testLogger);
  const objectStorage = createObjectStorage(
    infrastructure.objectStorageConfig,
    createMinioClient(infrastructure.objectStorageConfig),
    testLogger,
    createMinioSigningClient(infrastructure.objectStorageConfig),
  );
  const videoObjectStorage = createObjectStorage(
    infrastructure.videoObjectStorageConfig,
    createMinioClient(infrastructure.videoObjectStorageConfig),
    testLogger,
    createMinioSigningClient(infrastructure.videoObjectStorageConfig),
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
    databaseUrl: infrastructure.databaseUrl,
    redisUrl: infrastructure.redisUrl,
    objectStorageConfig: infrastructure.objectStorageConfig,
    postgresContainerId: infrastructure.postgresContainerId,
    prisma,
    redisClient,
    objectStorage,
    videoObjectStorage,
    externalResources,
    adminService: createIntegrationAdminService(prisma, objectStorage, delivered),
    authService: createIntegrationAuthService(prisma, objectStorage, delivered, externalResources),
    profilesService: createIntegrationProfilesService(prisma, objectStorage),
    videosService: createIntegrationVideosService(prisma, videoObjectStorage, externalResources),
    delivered,
  };
};

export const stopRuntime = async (runtime: TestRuntime | null): Promise<void> => {
  if (!runtime) {
    return;
  }

  await runtime.prisma.$disconnect();
  await closeRedisClient(runtime.redisClient, testLogger);
};

export const resetState = async (runtime: TestRuntime): Promise<void> => {
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
