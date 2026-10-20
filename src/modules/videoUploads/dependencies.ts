import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoUploadConfig } from '../../config/env.schema.js';
import type { ExternalResourceReconciler } from '../../services/externalResources.js';
import type { UserMediaProcessor } from '../../services/userMedia/userMedia.processor.js';

type UploadPrisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'externalMultipartHandle'
  | 'externalResourceTarget'
  | 'video'
  | 'videoSourceThumbnail'
  | 'videoTranscodeJob'
  | 'videoUploadSession'
>;

export type VideoUploadsDependencies = {
  prisma: UploadPrisma;
  objectStorage: Pick<
    ObjectStorage,
    | 'bucket'
    | 'completeMultipartUpload'
    | 'headObject'
    | 'initiateMultipartUpload'
    | 'listMultipartUploadParts'
    | 'putObject'
    | 'signMultipartUploadPart'
  >;
  externalResources: Pick<ExternalResourceReconciler, 'reconcileTarget'>;
  imageProcessor: Pick<UserMediaProcessor, 'processVideoThumbnail'>;
  clock: {
    now(): Date;
  };
  logger: {
    warn(data: object, message: string): void;
  };
  config: Pick<
    VideoUploadConfig,
    | 'maxUploadBytes'
    | 'maxTranscodeOutstandingJobs'
    | 'maxTranscodeOutstandingJobsPerUser'
    | 'partSizeBytes'
    | 'sessionTtlSeconds'
    | 'idleTtlSeconds'
    | 'maxReservationsPerHour'
    | 'userStorageQuotaBytes'
  >;
};
