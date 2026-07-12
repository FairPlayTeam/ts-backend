import config from './config/env.js';
import {
  createMinioClient,
  createMinioSigningClient,
  createObjectStorage,
  type ObjectStorage,
} from './lib/objectStorage.js';
import { logger } from './lib/logger.js';

const createConfiguredObjectStorage = (
  storageConfig: NonNullable<typeof config.objectStorage>,
): ObjectStorage =>
  createObjectStorage(
    storageConfig,
    createMinioClient(storageConfig),
    logger,
    createMinioSigningClient(storageConfig),
  );

export const objectStorage: ObjectStorage | null = config.objectStorage
  ? createConfiguredObjectStorage(config.objectStorage)
  : null;

export const videoObjectStorage: ObjectStorage | null = config.objectStorage
  ? createConfiguredObjectStorage({
      ...config.objectStorage,
      bucket: config.videoUpload.objectStorageBucket,
    })
  : null;
