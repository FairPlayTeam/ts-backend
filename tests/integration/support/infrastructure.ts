import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { ObjectStorageConfig } from '../../../src/config/env.schema.js';
import { buildRedisTestUrl, startRedisTestContainer } from './redis.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

const POSTGRES_PORT = 5432;
const GARAGE_S3_PORT = 3900;
export const OBJECT_STORAGE_BUCKET = 'fairplay-integration-media';
export const VIDEO_OBJECT_STORAGE_BUCKET = 'fairplay-integration-videos';
const OBJECT_STORAGE_ACCESS_KEY = 'fairplay';
const OBJECT_STORAGE_SECRET_KEY = 'fairplay-integration-secret';
const GARAGE_RPC_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const GARAGE_IMAGE =
  'dxflrs/garage@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020';

export type IntegrationInfrastructure = {
  databaseUrl: string;
  redisUrl: string;
  objectStorageConfig: ObjectStorageConfig;
  videoObjectStorageConfig: ObjectStorageConfig;
  postgresContainerId: string;
};

declare module 'vitest' {
  export interface ProvidedContext {
    integrationInfrastructure: IntegrationInfrastructure;
  }
}

const runPrismaMigrations = async (databaseUrl: string): Promise<void> => {
  await execFileAsync('bun', ['x', 'prisma', 'migrate', 'deploy'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    timeout: 120_000,
  });
};

const buildDatabaseUrl = (container: StartedTestContainer): string => {
  const host = container.getHost();
  const port = container.getMappedPort(POSTGRES_PORT);

  return `postgresql://user:password@${host}:${port}/fairplay?schema=public`;
};

export const buildObjectStorageConfig = (
  container: StartedTestContainer,
  bucket = OBJECT_STORAGE_BUCKET,
): ObjectStorageConfig => {
  const origin = `http://${container.getHost()}:${container.getMappedPort(GARAGE_S3_PORT)}`;
  const publicOrigin = new URL(origin);

  if (publicOrigin.hostname === 'localhost') {
    publicOrigin.hostname = '127.0.0.1';
  } else if (publicOrigin.hostname === '127.0.0.1') {
    publicOrigin.hostname = 'localhost';
  }

  return {
    endpoint: origin,
    publicUrl: publicOrigin.origin,
    region: 'us-east-1',
    bucket,
    accessKey: OBJECT_STORAGE_ACCESS_KEY,
    secretKey: OBJECT_STORAGE_SECRET_KEY,
    signedUrlTtlSeconds: 900,
    operationTimeoutMs: 10_000,
  };
};

export const startGarageContainer = async (
  dataDirectory?: string,
): Promise<StartedTestContainer> => {
  let container = new GenericContainer(GARAGE_IMAGE)
    .withEnvironment({
      GARAGE_RPC_SECRET,
      GARAGE_DEFAULT_ACCESS_KEY: OBJECT_STORAGE_ACCESS_KEY,
      GARAGE_DEFAULT_SECRET_KEY: OBJECT_STORAGE_SECRET_KEY,
      GARAGE_DEFAULT_BUCKET: 'garage-default',
    })
    .withCommand(['/garage', 'server', '--single-node', '--default-bucket'])
    .withCopyFilesToContainer([
      {
        source: join(projectRoot, 'docker', 'garage.toml'),
        target: '/etc/garage.toml',
      },
    ])
    .withExposedPorts(GARAGE_S3_PORT)
    .withWaitStrategy(Wait.forHttp('/', GARAGE_S3_PORT).forStatusCode(403))
    .withStartupTimeout(60_000);

  if (dataDirectory) {
    container = container.withBindMounts([
      {
        source: dataDirectory,
        target: '/var/lib/garage',
        mode: 'rw',
      },
    ]);
  }

  return container.start();
};

export const startIntegrationInfrastructure = async (): Promise<{
  context: IntegrationInfrastructure;
  stop: () => Promise<void>;
}> => {
  let postgresContainer: StartedTestContainer | null = null;
  let redisContainer: StartedTestContainer | null = null;
  let objectStorageContainer: StartedTestContainer | null = null;

  try {
    postgresContainer = await new GenericContainer('postgres:17-alpine')
      .withEnvironment({
        POSTGRES_USER: 'user',
        POSTGRES_PASSWORD: 'password',
        POSTGRES_DB: 'fairplay',
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
      .withStartupTimeout(120_000)
      .start();

    redisContainer = await startRedisTestContainer();

    objectStorageContainer = await startGarageContainer();

    const databaseUrl = buildDatabaseUrl(postgresContainer);
    await runPrismaMigrations(databaseUrl);

    const context: IntegrationInfrastructure = {
      databaseUrl,
      redisUrl: buildRedisTestUrl(redisContainer),
      objectStorageConfig: buildObjectStorageConfig(objectStorageContainer),
      videoObjectStorageConfig: buildObjectStorageConfig(
        objectStorageContainer,
        VIDEO_OBJECT_STORAGE_BUCKET,
      ),
      postgresContainerId: postgresContainer.getId(),
    };

    return {
      context,
      stop: async () => {
        await objectStorageContainer?.stop();
        await redisContainer?.stop();
        await postgresContainer?.stop();
      },
    };
  } catch (error) {
    await objectStorageContainer?.stop();
    await redisContainer?.stop();
    await postgresContainer?.stop();
    throw error;
  }
};
