import config from './config/env.js';
import {
  createS3ObjectStorageClient,
  createS3SigningClient,
  createObjectStorage,
  type ObjectStorage,
} from './lib/objectStorage.js';
import { logger } from './lib/logger.js';

const storageConfig = config.objectStorage;
const storageClient = storageConfig ? createS3ObjectStorageClient(storageConfig) : null;
const signingClient = storageConfig ? createS3SigningClient(storageConfig) : null;

export const objectStorage: ObjectStorage | null =
  storageConfig && storageClient && signingClient
    ? createObjectStorage(storageConfig, storageClient, logger, signingClient)
    : null;

export const videoObjectStorage: ObjectStorage | null =
  storageConfig && storageClient && signingClient
    ? createObjectStorage(
        {
          ...storageConfig,
          bucket: config.videoUpload.objectStorageBucket,
        },
        storageClient,
        logger,
        signingClient,
      )
    : null;
