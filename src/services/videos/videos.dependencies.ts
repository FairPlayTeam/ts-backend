import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoUploadConfig } from '../../config/env.parsers.js';
import type { ExternalResourceReconciler } from '../externalResources.js';
import type { UserMediaProcessor } from '../userMedia/userMedia.processor.js';
import type { VideoPublicIdGenerator } from './videoPublicId.js';

type Prisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'comment'
  | 'commentLike'
  | 'externalResourceTarget'
  | 'video'
  | 'videoArtifactGeneration'
  | 'videoRating'
  | 'videoSourceThumbnail'
  | 'videoUploadSession'
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
    | 'putObject'
    | 'readObject'
    | 'signMultipartUploadPart'
  >;
  externalResources: Pick<ExternalResourceReconciler, 'reconcileDue' | 'reconcileTarget'>;
  imageProcessor: Pick<UserMediaProcessor, 'processVideoThumbnail'>;
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
