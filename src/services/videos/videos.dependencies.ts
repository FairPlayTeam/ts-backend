import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoUploadConfig } from '../../config/env.parsers.js';
import type { VideoPublicIdGenerator } from './videoPublicId.js';

type Prisma = Pick<
  PrismaClient,
  '$transaction' | 'video' | 'videoTranscodeJob' | 'videoUploadSession'
>;

export type VideosDependencies = {
  prisma: Prisma;
  objectStorage: Pick<
    ObjectStorage,
    | 'abortMultipartUpload'
    | 'bucket'
    | 'completeMultipartUpload'
    | 'initiateMultipartUpload'
    | 'signMultipartUploadPart'
  >;
  clock: {
    now(): Date;
  };
  publicIdGenerator: VideoPublicIdGenerator;
  config: Pick<VideoUploadConfig, 'maxPartCount' | 'partSizeBytes' | 'sessionTtlSeconds'>;
};
