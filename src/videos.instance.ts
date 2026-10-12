import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { videoObjectStorage } from './objectStorage.instance.js';
import { createVideosService } from './modules/videos/index.js';
import { createVideoPublicId } from './modules/videos/shared/publicId.js';

export const videosService = createVideosService({
  prisma,
  objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
  clock: {
    now: () => new Date(),
  },
  publicIdGenerator: {
    generate: createVideoPublicId,
  },
  logger,
});
