import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { VideoTranscodeLimits } from './types.js';

export type VideoTranscodingPrisma = Pick<
  PrismaClient,
  | '$executeRaw'
  | '$queryRaw'
  | '$transaction'
  | 'externalResourceTarget'
  | 'video'
  | 'videoArtifactGeneration'
  | 'videoRendition'
  | 'videoSourceThumbnail'
  | 'videoTranscodeJob'
  | 'videoUploadSession'
>;

export type VideoTranscodingDependencies = {
  prisma: VideoTranscodingPrisma;
  objectStorage: Pick<ObjectStorage, 'bucket' | 'downloadObject' | 'headObject' | 'putObject'>;
  clock: {
    now(): Date;
  };
  config: VideoTranscodeLimits & {
    maxConcurrentJobs: number;
    threadsPerJob: number;
  };
  binaries?: {
    ffmpegPath?: string;
    ffprobePath?: string;
  };
  executionIdGenerator?: {
    generate(): string;
  };
  generationIdGenerator?: {
    generate(): string;
  };
  logger: {
    error(data: object, message: string): void;
    info(data: object, message: string): void;
    warn(data: object, message: string): void;
  };
};
