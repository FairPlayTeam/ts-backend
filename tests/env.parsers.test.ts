import { describe, expect, test } from 'bun:test';
import {
  ALL_CORS_ORIGINS,
  ServerConfigurationError,
  parseAllowedOrigins,
  parseIsProduction,
  parseJsonBodyLimitBytes,
  parseMailerConfig,
  parseOptionalObjectStorageConfig,
  parseOptionalRedisUrl,
  parseProfileMediaMaxUploadBytes,
  parseRateLimitKeySecret,
  parseRequiredHttpOriginUrl,
  parseRequiredHttpUrl,
  parseSessionCleanupInactiveRetentionMs,
  parseSessionCleanupIntervalMs,
  parseTrustProxy,
  readRequiredEnv,
} from '../src/config/env.parsers.js';
import {
  SESSION_CLEANUP_INACTIVE_RETENTION_MS,
  SESSION_CLEANUP_INTERVAL_MS,
} from '../src/config/constants.js';

describe('env parsers', () => {
  test('rejects missing required values', () => {
    expect(() => readRequiredEnv('', 'DATABASE_URL')).toThrow(ServerConfigurationError);
  });

  test('normalizes required URLs', () => {
    expect(parseRequiredHttpUrl('http://localhost:3000', 'BASE_URL')).toBe(
      'http://localhost:3000/',
    );
    expect(parseRequiredHttpUrl('https://api.example.com/v1', 'BASE_URL')).toBe(
      'https://api.example.com/v1',
    );
    expect(() => parseRequiredHttpUrl('ftp://example.com', 'BASE_URL')).toThrow(
      ServerConfigurationError,
    );
  });

  test('normalizes required HTTP origin URLs', () => {
    expect(parseRequiredHttpOriginUrl('http://localhost:9000', 'OBJECT_STORAGE_ENDPOINT')).toBe(
      'http://localhost:9000',
    );
    expect(parseRequiredHttpOriginUrl('https://s3.example.com/', 'OBJECT_STORAGE_ENDPOINT')).toBe(
      'https://s3.example.com',
    );
    expect(() =>
      parseRequiredHttpOriginUrl('https://s3.example.com/path', 'OBJECT_STORAGE_ENDPOINT'),
    ).toThrow(ServerConfigurationError);
    expect(() =>
      parseRequiredHttpOriginUrl('ftp://s3.example.com', 'OBJECT_STORAGE_ENDPOINT'),
    ).toThrow(ServerConfigurationError);
  });

  test('parses optional Redis URLs', () => {
    expect(parseOptionalRedisUrl(undefined, 'REDIS_URL')).toBeNull();
    expect(parseOptionalRedisUrl('redis://localhost:6379', 'REDIS_URL')).toBe(
      'redis://localhost:6379',
    );
    expect(parseOptionalRedisUrl('rediss://redis.example.com:6379', 'REDIS_URL')).toBe(
      'rediss://redis.example.com:6379',
    );
    expect(() => parseOptionalRedisUrl('http://localhost:6379', 'REDIS_URL')).toThrow(
      ServerConfigurationError,
    );
    expect(() => parseOptionalRedisUrl('not-a-url', 'REDIS_URL')).toThrow(ServerConfigurationError);
  });

  test('parses trust proxy values', () => {
    expect(parseTrustProxy(undefined, 'production')).toBe(false);
    expect(parseTrustProxy(undefined, 'development')).toBe('loopback');
    expect(() => parseTrustProxy('true')).toThrow(ServerConfigurationError);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback, linklocal')).toEqual(['loopback', 'linklocal']);
  });

  test('parses JSON body limit bytes', () => {
    expect(parseJsonBodyLimitBytes('2048')).toBe(2048);
    expect(() => parseJsonBodyLimitBytes('1mb')).toThrow(ServerConfigurationError);
  });

  test('parses profile media upload size limits', () => {
    expect(parseProfileMediaMaxUploadBytes(undefined)).toBe(3 * 1024 * 1024);
    expect(parseProfileMediaMaxUploadBytes('2048')).toBe(2048);
    expect(() => parseProfileMediaMaxUploadBytes('0')).toThrow(ServerConfigurationError);
  });

  test('parses session cleanup intervals', () => {
    expect(parseSessionCleanupIntervalMs(undefined)).toBe(SESSION_CLEANUP_INTERVAL_MS);
    expect(parseSessionCleanupIntervalMs('60')).toBe(60 * 60 * 1000);
    expect(parseSessionCleanupInactiveRetentionMs(undefined)).toBe(
      SESSION_CLEANUP_INACTIVE_RETENTION_MS,
    );
    expect(parseSessionCleanupInactiveRetentionMs('1')).toBe(24 * 60 * 60 * 1000);
    expect(() => parseSessionCleanupIntervalMs('0')).toThrow(ServerConfigurationError);
    expect(() => parseSessionCleanupInactiveRetentionMs('1h')).toThrow(ServerConfigurationError);
  });

  test('parses runtime mode', () => {
    expect(parseIsProduction('production')).toBe(true);
    expect(parseIsProduction('development')).toBe(false);
  });

  test('parses rate limit key secrets', () => {
    expect(parseRateLimitKeySecret(undefined, false)).toBe(
      'development-rate-limit-key-secret-change-me',
    );
    expect(parseRateLimitKeySecret('a'.repeat(32), true)).toBe('a'.repeat(32));
    expect(() => parseRateLimitKeySecret(undefined, true)).toThrow(ServerConfigurationError);
    expect(() => parseRateLimitKeySecret('too-short', false)).toThrow(ServerConfigurationError);
    expect(() => parseRateLimitKeySecret('change-me-with-at-least-32-characters', true)).toThrow(
      ServerConfigurationError,
    );
  });

  test('parses and normalizes allowed CORS origins', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('*')).toBe(ALL_CORS_ORIGINS);
    expect(parseAllowedOrigins('http://localhost:5173, https://example.com/path')).toEqual([
      'http://localhost:5173',
      'https://example.com',
    ]);
    expect(() => parseAllowedOrigins('*, https://example.com')).toThrow(ServerConfigurationError);
    expect(() => parseAllowedOrigins('not-a-url')).toThrow(ServerConfigurationError);
    expect(() => parseAllowedOrigins('ftp://example.com')).toThrow(ServerConfigurationError);
  });

  test('parses optional mailer configuration', () => {
    expect(
      parseMailerConfig({
        smtpHost: undefined,
        smtpPort: undefined,
        smtpUser: undefined,
        smtpPass: undefined,
        smtpFrom: undefined,
        frontendUrl: undefined,
      }),
    ).toBeNull();

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: undefined,
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        frontendUrl: 'http://localhost:5173',
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        frontendUrl: 'ftp://localhost:5173',
      }),
    ).toThrow(ServerConfigurationError);

    expect(
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        frontendUrl: 'http://localhost:5173',
      }),
    ).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUser: 'user@example.com',
      smtpPass: 'secret',
      smtpFrom: 'no-reply@example.com',
      frontendUrl: 'http://localhost:5173/',
    });
  });

  test('parses optional object storage configuration', () => {
    expect(
      parseOptionalObjectStorageConfig({
        endpoint: undefined,
        publicUrl: undefined,
        region: undefined,
        bucket: undefined,
        accessKey: undefined,
        secretKey: undefined,
        signedUrlTtlSeconds: undefined,
      }),
    ).toBeNull();

    expect(() =>
      parseOptionalObjectStorageConfig({
        endpoint: 'http://localhost:9000',
        publicUrl: undefined,
        region: undefined,
        bucket: undefined,
        accessKey: 'fairplay',
        secretKey: undefined,
        signedUrlTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(
      parseOptionalObjectStorageConfig({
        endpoint: 'http://localhost:9000',
        publicUrl: 'http://localhost:9000',
        region: undefined,
        bucket: undefined,
        accessKey: 'fairplay',
        secretKey: 'fairplay-minio-secret',
        signedUrlTtlSeconds: undefined,
      }),
    ).toEqual({
      endpoint: 'http://localhost:9000',
      publicUrl: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'fairplay-user-media',
      accessKey: 'fairplay',
      secretKey: 'fairplay-minio-secret',
      signedUrlTtlSeconds: 900,
    });

    expect(
      parseOptionalObjectStorageConfig({
        endpoint: 'http://minio:9000',
        publicUrl: undefined,
        region: 'eu-west-3',
        bucket: 'fairplay-media',
        accessKey: 'fairplay',
        secretKey: 'fairplay-minio-secret',
        signedUrlTtlSeconds: '60',
      }),
    ).toEqual({
      endpoint: 'http://minio:9000',
      publicUrl: 'http://minio:9000',
      region: 'eu-west-3',
      bucket: 'fairplay-media',
      accessKey: 'fairplay',
      secretKey: 'fairplay-minio-secret',
      signedUrlTtlSeconds: 60,
    });

    expect(() =>
      parseOptionalObjectStorageConfig({
        endpoint: 'http://localhost:9000/path',
        publicUrl: undefined,
        region: undefined,
        bucket: undefined,
        accessKey: 'fairplay',
        secretKey: 'fairplay-minio-secret',
        signedUrlTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      parseOptionalObjectStorageConfig({
        endpoint: 'http://localhost:9000',
        publicUrl: undefined,
        region: undefined,
        bucket: 'Invalid_Bucket',
        accessKey: 'fairplay',
        secretKey: 'fairplay-minio-secret',
        signedUrlTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      parseOptionalObjectStorageConfig({
        endpoint: 'http://localhost:9000',
        publicUrl: undefined,
        region: undefined,
        bucket: undefined,
        accessKey: 'fairplay',
        secretKey: 'fairplay-minio-secret',
        signedUrlTtlSeconds: String(7 * 24 * 60 * 60 + 1),
      }),
    ).toThrow(ServerConfigurationError);
  });
});
