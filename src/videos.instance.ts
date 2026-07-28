import config from './config/env.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { videoObjectStorage } from './objectStorage.instance.js';
import { createVideosService } from './services/videos.service.js';
import { createVideoPublicId } from './services/videos/videoPublicId.js';
import { externalResourceReconciler } from './externalResources.instance.js';
import { createUserMediaProcessor } from './services/userMedia/userMedia.processor.js';

export const videosService = createVideosService({
  prisma,
  objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
  externalResources: externalResourceReconciler,
  imageProcessor: createUserMediaProcessor({
    profileMediaMaxUploadBytes: config.profileMediaMaxUploadBytes,
  }),
  clock: {
    now: () => new Date(),
  },
  publicIdGenerator: {
    generate: createVideoPublicId,
  },
  logger,
  config: {
    maxPartCount: config.videoUpload.maxPartCount,
    maxUploadBytes: config.videoUpload.maxUploadBytes,
    partSizeBytes: config.videoUpload.partSizeBytes,
    sessionTtlSeconds: config.videoUpload.sessionTtlSeconds,
    userStorageQuotaBytes: config.videoUpload.userStorageQuotaBytes,
  },
});
