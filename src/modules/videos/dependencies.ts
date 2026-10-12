import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoPublicIdGenerator } from './shared/publicId.js';

type Prisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'externalResourceTarget'
  | 'video'
  | 'videoArtifactGeneration'
  | 'videoRating'
  | 'videoTranscodeJob'
>;

export type VideosDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'getSignedUrl' | 'headObject' | 'readObject'>;
  clock: {
    now(): Date;
  };
  publicIdGenerator: VideoPublicIdGenerator;
  logger: {
    warn(data: object, message: string): void;
  };
};
