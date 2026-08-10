import crypto from 'node:crypto';
import type { RedisClient } from './redis.js';

const RELEASE_LEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end

return 0
`;
const RENEW_LEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end

return 0
`;

export type RedisLease = {
  renewalIntervalMs: number;
  renew(): Promise<boolean>;
  release(): Promise<void>;
};

export type RedisLeaseManager = {
  acquire(key: string): Promise<RedisLease | null>;
};

export const createRedisLeaseManager = ({
  redisClient,
  ttlMs,
  tokenFactory = () => crypto.randomUUID(),
}: {
  redisClient: Pick<RedisClient, 'call'>;
  ttlMs: number;
  tokenFactory?: () => string;
}): RedisLeaseManager => ({
  async acquire(key) {
    const token = tokenFactory();
    const result = await redisClient.call('set', key, token, 'PX', String(ttlMs), 'NX');

    if (result !== 'OK') {
      return null;
    }

    return {
      renewalIntervalMs: Math.max(10, Math.floor(ttlMs / 3)),
      async renew() {
        const renewed = await redisClient.call(
          'eval',
          RENEW_LEASE_SCRIPT,
          '1',
          key,
          token,
          String(ttlMs),
        );

        return renewed === 1;
      },
      async release() {
        await redisClient.call('eval', RELEASE_LEASE_SCRIPT, '1', key, token);
      },
    };
  },
});
