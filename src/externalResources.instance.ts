import { logger } from './lib/logger.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { objectStorage, videoObjectStorage } from './objectStorage.instance.js';
import { createExternalResourceReconciler } from './services/externalResources.js';

export const externalResourceReconciler = createExternalResourceReconciler({
  prisma,
  objectStorage: objectStorage ?? videoObjectStorage ?? createUnavailableObjectStorage(),
  clock: {
    now: () => new Date(),
  },
  logger,
});
