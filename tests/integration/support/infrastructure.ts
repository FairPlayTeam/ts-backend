import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { ObjectStorageConfig } from '../../../src/config/env.parsers.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));

const POSTGRES_PORT = 5432;
const REDIS_PORT = 6379;
const MINIO_PORT = 9000;
export const OBJECT_STORAGE_BUCKET = 'fairplay-integration-media';
export const VIDEO_OBJECT_STORAGE_BUCKET = 'fairplay-integration-videos';
const OBJECT_STORAGE_ACCESS_KEY = 'fairplay';
const OBJECT_STORAGE_SECRET_KEY = 'fairplay-minio-secret';

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

const buildRedisUrl = (container: StartedTestContainer): string => {
  const host = container.getHost();
  const port = container.getMappedPort(REDIS_PORT);

  return `redis://${host}:${port}`;
};

const buildObjectStorageConfig = (
  container: StartedTestContainer,
  bucket = OBJECT_STORAGE_BUCKET,
): ObjectStorageConfig => {
  const origin = `http://${container.getHost()}:${container.getMappedPort(MINIO_PORT)}`;
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

export const startIntegrationInfrastructure = async (): Promise<{
  context: IntegrationInfrastructure;
  stop: () => Promise<void>;
}> => {
  let postgresContainer: StartedTestContainer | null = null;
  let redisContainer: StartedTestContainer | null = null;
  let minioContainer: StartedTestContainer | null = null;

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

    redisContainer = await new GenericContainer('redis:8-alpine')
      .withCommand(['redis-server', '--save', '', '--appendonly', 'no'])
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
      .withStartupTimeout(60_000)
      .start();

    minioContainer = await new GenericContainer('minio/minio:RELEASE.2025-09-07T16-13-09Z')
      .withEnvironment({
        MINIO_ROOT_USER: OBJECT_STORAGE_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: OBJECT_STORAGE_SECRET_KEY,
      })
      .withCommand(['server', '/data', '--console-address', ':9001'])
      .withExposedPorts(MINIO_PORT)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', MINIO_PORT).forStatusCode(200))
      .withStartupTimeout(60_000)
      .start();

    const databaseUrl = buildDatabaseUrl(postgresContainer);
    await runPrismaMigrations(databaseUrl);

    const context: IntegrationInfrastructure = {
      databaseUrl,
      redisUrl: buildRedisUrl(redisContainer),
      objectStorageConfig: buildObjectStorageConfig(minioContainer),
      videoObjectStorageConfig: buildObjectStorageConfig(
        minioContainer,
        VIDEO_OBJECT_STORAGE_BUCKET,
      ),
      postgresContainerId: postgresContainer.getId(),
    };

    return {
      context,
      stop: async () => {
        await minioContainer?.stop();
        await redisContainer?.stop();
        await postgresContainer?.stop();
      },
    };
  } catch (error) {
    await minioContainer?.stop();
    await redisContainer?.stop();
    await postgresContainer?.stop();
    throw error;
  }
};
