import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoUploadConfig } from '../../config/env.parsers.js';
import type { ExternalResourceReconciler } from '../externalResources.js';
import type { VideoPublicIdGenerator } from './videoPublicId.js';

type Prisma = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'video' | 'videoArtifactGeneration' | 'videoUploadSession'
>;

export type VideosDependencies = {
  prisma: Prisma;
  objectStorage: Pick<
    ObjectStorage,
    | 'bucket'
    | 'completeMultipartUpload'
    | 'headObject'
    | 'initiateMultipartUpload'
    | 'getSignedUrl'
    | 'readObject'
    | 'signMultipartUploadPart'
  >;
  externalResources: Pick<ExternalResourceReconciler, 'reconcileDue' | 'reconcileTarget'>;
  clock: {
    now(): Date;
  };
  publicIdGenerator: VideoPublicIdGenerator;
  logger: {
    warn(data: object, message: string): void;
  };
  config: Pick<
    VideoUploadConfig,
    | 'maxPartCount'
    | 'maxUploadBytes'
    | 'partSizeBytes'
    | 'sessionTtlSeconds'
    | 'userStorageQuotaBytes'
  >;
};
