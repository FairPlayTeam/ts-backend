import { randomUUID } from 'node:crypto';
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
  USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
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

type DeliveredVideoRejectionEmail = {
  email: string;
  title: string;
  reason: string;
};

type DeliveredVideoDeletionEmail = {
  email: string;
  title: string;
  reason: string;
};

export type TestRuntime = {
  databaseUrl: string;
  postgresApplicationName: string;
  redisUrl: string;
  objectStorageConfig: ObjectStorageConfig;
  postgresContainerId: string;
  prisma: PrismaClient;
  redisClient: Redis;
  objectStorage: ObjectStorage;
  videoObjectStorage: ObjectStorage;
  userMediaExternalResources: ExternalResourceReconciler;
  videoExternalResources: ExternalResourceReconciler;
  adminService: AdminPorts;
  authService: AuthPorts;
  profilesService: ProfilesPorts;
  videosService: VideosService;
  delivered: {
    verification: DeliveredEmail[];
    passwordReset: DeliveredEmail[];
    accountBan: DeliveredBanEmail[];
    videoRejection: DeliveredVideoRejectionEmail[];
    videoDeletion: DeliveredVideoDeletionEmail[];
  };
};

export const testLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const createPostgresApplicationName = (): string => `fp-test-${randomUUID()}`;

const withPostgresApplicationName = (databaseUrl: string, applicationName?: string): string => {
  if (!applicationName) {
    return databaseUrl;
  }

  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);

  return url.toString();
};

export const createPrismaClient = (
  databaseUrl: string,
  { applicationName }: { applicationName?: string } = {},
): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: withPostgresApplicationName(databaseUrl, applicationName),
    }),
  });

export const createQueryObservedPrismaClient = (
  databaseUrl: string,
  onQuery: (event: Prisma.QueryEvent) => void,
) => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
    log: [{ emit: 'event', level: 'query' }],
  });

  prisma.$on('query', onQuery);

  return prisma;
};

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
  delivered: TestRuntime['delivered'],
  now: () => Date = () => new Date(),
): AdminPorts =>
  createAdminService({
    prisma,
    mailer: {
      sendAccountBannedEmail: async (email, reason) => {
        delivered.accountBan.push({ email, reason });
      },
      sendVideoRejectedEmail: async (email, title, reason) => {
        delivered.videoRejection.push({ email, title, reason });
      },
      sendVideoDeletionScheduledEmail: async (email, title, reason) => {
        delivered.videoDeletion.push({ email, title, reason });
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
    maxProxyBytes: {
      avatar: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
      banner: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    },
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

export const createVideoReadBarrierService = (
  runtime: TestRuntime,
  afterVideoRead: () => Promise<void>,
): VideosService => {
  const barrierPrisma = new Proxy(runtime.prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ): Promise<T> =>
          target.$transaction(async (tx) => {
            const barrierTransaction = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === 'video') {
                  return new Proxy(transactionTarget.video, {
                    get(videoTarget, videoProperty) {
                      if (videoProperty === 'findFirst') {
                        return async (...args: Parameters<typeof videoTarget.findFirst>) => {
                          const video = await videoTarget.findFirst(...args);
                          await afterVideoRead();

                          return video;
                        };
                      }

                      const value = Reflect.get(videoTarget, videoProperty, videoTarget) as unknown;

                      return typeof value === 'function' ? value.bind(videoTarget) : value;
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

            return run(barrierTransaction);
          }, options);
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return createIntegrationVideosService(
    barrierPrisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
  );
};

export const createIntegrationApp = async (
  runtime: TestRuntime,
  overrides: {
    authService?: AuthPorts;
    videosService?: VideosService;
  } = {},
) =>
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
      authService: overrides.authService ?? runtime.authService,
      profilesService: runtime.profilesService,
      videosService: overrides.videosService ?? runtime.videosService,
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
  const postgresApplicationName = createPostgresApplicationName();
  const prisma = createPrismaClient(infrastructure.databaseUrl, {
    applicationName: postgresApplicationName,
  });
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
  const userMediaExternalResources = createExternalResourceReconciler({
    prisma,
    objectStorage,
    clock: {
      now: () => new Date(),
    },
    logger: testLogger,
    allowedRoles: USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
  });
  const videoExternalResources = createExternalResourceReconciler({
    prisma,
    objectStorage: videoObjectStorage,
    clock: {
      now: () => new Date(),
    },
    logger: testLogger,
    allowedRoles: VIDEO_EXTERNAL_RESOURCE_ROLES,
  });
  await connectRedisClient(redisClient);

  const delivered = {
    verification: [] as DeliveredEmail[],
    passwordReset: [] as DeliveredEmail[],
    accountBan: [] as DeliveredBanEmail[],
    videoRejection: [] as DeliveredVideoRejectionEmail[],
    videoDeletion: [] as DeliveredVideoDeletionEmail[],
  };

  return {
    databaseUrl: infrastructure.databaseUrl,
    postgresApplicationName,
    redisUrl: infrastructure.redisUrl,
    objectStorageConfig: infrastructure.objectStorageConfig,
    postgresContainerId: infrastructure.postgresContainerId,
    prisma,
    redisClient,
    objectStorage,
    videoObjectStorage,
    userMediaExternalResources,
    videoExternalResources,
    adminService: createIntegrationAdminService(prisma, delivered),
    authService: createIntegrationAuthService(
      prisma,
      objectStorage,
      delivered,
      userMediaExternalResources,
    ),
    profilesService: createIntegrationProfilesService(prisma, objectStorage),
    videosService: createIntegrationVideosService(
      prisma,
      videoObjectStorage,
      videoExternalResources,
    ),
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
  await runtime.prisma.comment.deleteMany();
  await runtime.prisma.user.deleteMany();
  await runtime.prisma.externalResourceTarget.deleteMany();
  await runtime.redisClient.call('flushdb');
  runtime.delivered.verification = [];
  runtime.delivered.passwordReset = [];
  runtime.delivered.accountBan = [];
  runtime.delivered.videoRejection = [];
  runtime.delivered.videoDeletion = [];
};
