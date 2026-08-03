import { logger } from './lib/logger.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { objectStorage, videoObjectStorage } from './objectStorage.instance.js';
import {
  createExternalResourceReconciler,
  USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
} from './services/externalResources.js';

const systemClock = {
  now: () => new Date(),
};

export const userMediaExternalResourceReconciler = createExternalResourceReconciler({
  prisma,
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
  clock: systemClock,
  logger,
  allowedRoles: USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
});

export const videoExternalResourceReconciler = createExternalResourceReconciler({
  prisma,
  objectStorage: videoObjectStorage ?? createUnavailableObjectStorage(),
  clock: systemClock,
  logger,
  allowedRoles: VIDEO_EXTERNAL_RESOURCE_ROLES,
});
