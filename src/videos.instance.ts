import config from './config/env.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { videoObjectStorage } from './objectStorage.instance.js';
import { createVideosService } from './services/videos.service.js';
import { createVideoPublicId } from './services/videos/videoPublicId.js';

export const videosService = createVideosService({
  prisma,
  objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
  clock: {
    now: () => new Date(),
  },
  publicIdGenerator: {
    generate: createVideoPublicId,
  },
  config: {
    maxPartCount: config.videoUpload.maxPartCount,
    partSizeBytes: config.videoUpload.partSizeBytes,
    sessionTtlSeconds: config.videoUpload.sessionTtlSeconds,
  },
});
