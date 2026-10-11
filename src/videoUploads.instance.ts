import config from './config/env.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { videoObjectStorage } from './objectStorage.instance.js';
import { videoExternalResourceReconciler } from './externalResources.instance.js';
import { createUserMediaProcessor } from './services/userMedia/userMedia.processor.js';
import {
  createVideoUploadsReconciliationHandlers,
  createVideoUploadsService,
  type VideoUploadsDependencies,
} from './modules/videoUploads/index.js';

const dependencies: VideoUploadsDependencies = {
  prisma,
  objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
  externalResources: videoExternalResourceReconciler,
  imageProcessor: createUserMediaProcessor({
    profileMediaMaxUploadBytes: config.profileMediaMaxUploadBytes,
  }),
  clock: {
    now: () => new Date(),
  },
  logger,
  config: {
    maxUploadBytes: config.videoUpload.maxUploadBytes,
    maxTranscodeOutstandingJobs: config.videoUpload.maxTranscodeOutstandingJobs,
    maxTranscodeOutstandingJobsPerUser: config.videoUpload.maxTranscodeOutstandingJobsPerUser,
    partSizeBytes: config.videoUpload.partSizeBytes,
    sessionTtlSeconds: config.videoUpload.sessionTtlSeconds,
    userStorageQuotaBytes: config.videoUpload.userStorageQuotaBytes,
  },
};

export const videoUploadsService = createVideoUploadsService(dependencies);
export const videoUploadsReconciliationHandlers =
  createVideoUploadsReconciliationHandlers(dependencies);
