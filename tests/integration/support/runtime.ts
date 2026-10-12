import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { inject } from 'vitest';

import { createApp } from '../../../src/app.js';
import {
  DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS,
  DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER,
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
  createS3ObjectStorageClient,
  createS3SigningClient,
  createObjectStorage,
  type ObjectStorage,
} from '../../../src/lib/objectStorage.js';
import { closeRedisClient, connectRedisClient, createRedisClient } from '../../../src/lib/redis.js';
import { createAdminService } from '../../../src/modules/admin/index.js';
import { createAuthService } from '../../../src/modules/auth/index.js';
import {
  createExternalResourceReconciler,
  type ExternalResourceReconciler,
  type ExternalResourceReconciliationHandlers,
  USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
} from '../../../src/services/externalResources.js';
import {
  createFollowingProfilesCursorCodec,
  createProfilesService,
  type ProfilesPort,
} from '../../../src/modules/profiles/index.js';
import { createCommentsService, type CommentsPort } from '../../../src/modules/comments/index.js';
import { createUserMediaProcessor } from '../../../src/services/userMedia/userMedia.processor.js';
import { createVideosService } from '../../../src/modules/videos/index.js';
import { createVideoPublicId } from '../../../src/modules/videos/shared/publicId.js';
import {
  createVideoArtifactReconciliationHandlers,
  scheduleAbandonedVideoArtifactGenerations,
} from '../../../src/modules/videoTranscoding/index.js';
import {
  createVideoUploadsReconciliationHandlers,
  createVideoUploadsService,
  type VideoUploadsDependencies,
  type VideoUploadsMaintenancePort,
  type VideoUploadsPort,
} from '../../../src/modules/videoUploads/index.js';
import type { AdminService } from '../../../src/modules/admin/index.js';
import type { AuthService } from '../../../src/modules/auth/index.js';
import type { VideosService } from '../../../src/modules/videos/index.js';
import type { VideoTranscodingMaintenancePort } from '../../../src/modules/videoTranscoding/index.js';
import type { ObjectStorageConfig } from '../../../src/config/env.schema.js';
import type { VideoTranscodeLimits } from '../../../src/modules/videoTranscoding/types.js';
import type { Redis } from 'ioredis';
import { testLogger } from './logger.js';

export { testLogger } from './logger.js';

export const PROFILE_MEDIA_MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const AUTH_CODE_PEPPER = 'integration-auth-code-pepper-change-me';
export const VIDEO_TRANSCODE_TEST_CONFIG = {
  ffmpegTimeoutMs: 60_000,
  ffprobeTimeoutMs: 10_000,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxAspectRatio: 4,
  maxConcurrentJobs: 1,
  maxDurationSeconds: 60,
  maxFps: 60,
  maxHeight: 3840,
  maxPixels: 3840 * 2160,
  maxWidth: 3840,
  threadsPerJob: 1,
} satisfies VideoTranscodeLimits & {
  maxConcurrentJobs: number;
  threadsPerJob: number;
};

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
  videoObjectStorageConfig: ObjectStorageConfig;
  postgresContainerId: string;
  prisma: PrismaClient;
  redisClient: Redis;
  objectStorage: ObjectStorage;
  videoObjectStorage: ObjectStorage;
  closeObjectStorageClients(): void;
  userMediaExternalResources: ExternalResourceReconciler;
  videoExternalResources: ExternalResourceReconciler;
  adminService: AdminService;
  authService: AuthService;
  profilesService: ProfilesPort;
  commentsService: CommentsPort;
  videosService: VideosService;
  videoUploadsService: VideoUploadsPort & VideoUploadsMaintenancePort;
  videoTranscodingMaintenance: VideoTranscodingMaintenancePort;
  videoUploadsReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'source' | 'source_thumbnail'>
  >;
  videoTranscodingReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'hls_artifacts' | 'thumbnail_prefix'>
  >;
  reconcileVideoExternalResources(input?: { limit?: number }): Promise<{
    claimed: number;
    confirmed: number;
    redirectedAbsent: number;
    failed: number;
  }>;
  delivered: {
    verification: DeliveredEmail[];
    passwordReset: DeliveredEmail[];
    accountBan: DeliveredBanEmail[];
    videoRejection: DeliveredVideoRejectionEmail[];
    videoDeletion: DeliveredVideoDeletionEmail[];
  };
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
): AuthService =>
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
    logger: testLogger,
  });

export const createIntegrationAdminService = (
  prisma: PrismaClient,
  delivered: TestRuntime['delivered'],
  now: () => Date = () => new Date(),
): AdminService =>
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
    logger: testLogger,
  });

export const createIntegrationProfilesService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
): ProfilesPort =>
  createProfilesService({
    prisma,
    objectStorage,
    followingProfilesCursorCodec: createFollowingProfilesCursorCodec(
      Buffer.from('22'.repeat(32), 'hex'),
    ),
    maxProxyBytes: {
      avatar: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
      banner: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    },
  });

export const createIntegrationVideosService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  config: {
    now?: () => Date;
    publicIds?: string[];
  } = {},
): VideosService =>
  createVideosService({
    prisma,
    objectStorage,
    clock: {
      now: config.now ?? (() => new Date()),
    },
    publicIdGenerator: {
      generate: () => config.publicIds?.shift() ?? createVideoPublicId(),
    },
    logger: testLogger,
  });

export const createIntegrationVideoUploadsDependencies = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  externalResources: ExternalResourceReconciler,
  config: {
    maxUploadBytes?: number;
    maxTranscodeOutstandingJobs?: number;
    maxTranscodeOutstandingJobsPerUser?: number;
    now?: () => Date;
    userStorageQuotaBytes?: number;
  } = {},
): VideoUploadsDependencies => ({
  prisma,
  objectStorage,
  externalResources,
  imageProcessor: createUserMediaProcessor({
    profileMediaMaxUploadBytes: PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  }),
  clock: {
    now: config.now ?? (() => new Date()),
  },
  logger: testLogger,
  config: {
    maxUploadBytes: config.maxUploadBytes ?? 3 * 1024 * 1024 * 1024,
    maxTranscodeOutstandingJobs:
      config.maxTranscodeOutstandingJobs ?? DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS,
    maxTranscodeOutstandingJobsPerUser:
      config.maxTranscodeOutstandingJobsPerUser ??
      DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER,
    partSizeBytes: 67_108_864,
    sessionTtlSeconds: 86_400,
    userStorageQuotaBytes: config.userStorageQuotaBytes ?? 100 * 1024 * 1024 * 1024,
  },
});

export const createIntegrationVideoUploadsService = (
  prisma: PrismaClient,
  objectStorage: ObjectStorage,
  externalResources: ExternalResourceReconciler,
  config: Parameters<typeof createIntegrationVideoUploadsDependencies>[3] = {},
): VideoUploadsPort & VideoUploadsMaintenancePort =>
  createVideoUploadsService(
    createIntegrationVideoUploadsDependencies(prisma, objectStorage, externalResources, config),
  );

export const reconcileVideoExternalResources = (
  externalResources: Pick<ExternalResourceReconciler, 'reconcileDue'>,
  videoUploadsReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'source' | 'source_thumbnail'>
  >,
  videoTranscodingReconciliationHandlers: Required<
    Pick<ExternalResourceReconciliationHandlers, 'hls_artifacts' | 'thumbnail_prefix'>
  >,
  input: { limit?: number } = {},
) =>
  externalResources.reconcileDue({
    roles: VIDEO_EXTERNAL_RESOURCE_ROLES,
    ...input,
    handlers: {
      ...videoUploadsReconciliationHandlers,
      ...videoTranscodingReconciliationHandlers,
    },
  });

export const createIntegrationCommentsService = (
  prisma: PrismaClient,
  config: {
    now?: () => Date;
  } = {},
): CommentsPort =>
  createCommentsService({
    prisma,
    clock: {
      now: config.now ?? (() => new Date()),
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

  return createIntegrationVideosService(barrierPrisma, runtime.videoObjectStorage);
};

export const createIntegrationVideoTranscodingMaintenance = (
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): VideoTranscodingMaintenancePort => ({
  scheduleAbandonedArtifactGenerations: ({ observedAt }) =>
    scheduleAbandonedVideoArtifactGenerations({ prisma, clock: { now } }, { observedAt }),
});

export const createIntegrationApp = async (
  runtime: TestRuntime,
  overrides: {
    authService?: AuthService;
    commentsService?: CommentsPort;
    videosService?: VideosService;
    videoUploadsService?: VideoUploadsPort;
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
      commentsService: overrides.commentsService ?? runtime.commentsService,
      videosService: overrides.videosService ?? runtime.videosService,
      videoUploadsService: overrides.videoUploadsService ?? runtime.videoUploadsService,
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
  const objectStorageClient = createS3ObjectStorageClient(infrastructure.objectStorageConfig);
  const objectStorageSigningClient = createS3SigningClient(infrastructure.objectStorageConfig);
  const objectStorage = createObjectStorage(
    infrastructure.objectStorageConfig,
    objectStorageClient,
    testLogger,
    objectStorageSigningClient,
  );
  const videoObjectStorage = createObjectStorage(
    infrastructure.videoObjectStorageConfig,
    objectStorageClient,
    testLogger,
    objectStorageSigningClient,
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
  const videoUploadsDependencies = createIntegrationVideoUploadsDependencies(
    prisma,
    videoObjectStorage,
    videoExternalResources,
  );
  const videoUploadsService = createVideoUploadsService(videoUploadsDependencies);
  const videoUploadsReconciliationHandlers =
    createVideoUploadsReconciliationHandlers(videoUploadsDependencies);
  const videoTranscodingReconciliationHandlers = createVideoArtifactReconciliationHandlers({
    now: () => new Date(),
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
    videoObjectStorageConfig: infrastructure.videoObjectStorageConfig,
    postgresContainerId: infrastructure.postgresContainerId,
    prisma,
    redisClient,
    objectStorage,
    videoObjectStorage,
    closeObjectStorageClients: () => {
      objectStorageClient.destroy();
      objectStorageSigningClient.destroy();
    },
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
    commentsService: createIntegrationCommentsService(prisma),
    videosService: createIntegrationVideosService(prisma, videoObjectStorage),
    videoUploadsService,
    videoTranscodingMaintenance: createIntegrationVideoTranscodingMaintenance(prisma),
    videoUploadsReconciliationHandlers,
    videoTranscodingReconciliationHandlers,
    reconcileVideoExternalResources: (input = {}) =>
      reconcileVideoExternalResources(
        videoExternalResources,
        videoUploadsReconciliationHandlers,
        videoTranscodingReconciliationHandlers,
        input,
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
  runtime.closeObjectStorageClients();
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
