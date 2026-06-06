import config from './config/env.js';
import { createMinioClient, createObjectStorage, type ObjectStorage } from './lib/objectStorage.js';
import { logger } from './lib/logger.js';

export const objectStorage: ObjectStorage | null = config.objectStorage
  ? createObjectStorage(config.objectStorage, createMinioClient(config.objectStorage), logger)
  : null;
