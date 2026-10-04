import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const REDIS_PORT = 6379;

export const startRedisTestContainer = ({ hostPort }: { hostPort?: number } = {}) =>
  new GenericContainer('redis:8-alpine')
    .withCommand(['redis-server', '--save', '', '--appendonly', 'no'])
    .withExposedPorts(
      hostPort === undefined ? REDIS_PORT : { container: REDIS_PORT, host: hostPort },
    )
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
    .withStartupTimeout(60_000)
    .start();

export const buildRedisTestUrl = (container: StartedTestContainer): string =>
  `redis://${container.getHost()}:${container.getMappedPort(REDIS_PORT)}`;
