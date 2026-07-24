import { describe, expect, test } from 'bun:test';
import {
  ALL_CORS_ORIGINS,
  ServerConfigurationError,
  assertProductionMailerConfig,
  parseAllowedOrigins,
  parseAuthCodePepper,
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
  parseVideoTranscodeConfig,
  parseVideoUploadConfig,
  readRequiredEnv,
} from '../src/config/env.parsers.js';
import {
  DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET,
  DEFAULT_VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
  DEFAULT_VIDEO_TRANSCODE_THREADS_PER_JOB,
  DEFAULT_VIDEO_UPLOAD_MAX_BYTES,
  DEFAULT_VIDEO_UPLOAD_MAX_PARTS,
  DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES,
  DEFAULT_VIDEO_UPLOAD_SESSION_TTL_SECONDS,
  DEFAULT_VIDEO_USER_STORAGE_QUOTA_BYTES,
  DEFAULT_OBJECT_STORAGE_TIMEOUT_MS,
  DEFAULT_SMTP_TIMEOUT_MS,
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

  test('parses auth code peppers', () => {
    expect(parseAuthCodePepper(undefined, false)).toBe('development-auth-code-pepper-change-me');
    expect(parseAuthCodePepper('b'.repeat(32), true)).toBe('b'.repeat(32));
    expect(() => parseAuthCodePepper(undefined, true)).toThrow(ServerConfigurationError);
    expect(() => parseAuthCodePepper('too-short', false)).toThrow(ServerConfigurationError);
    expect(() => parseAuthCodePepper('change-me-auth-code-pepper-32-characters', true)).toThrow(
      ServerConfigurationError,
    );
    expect(() =>
      parseAuthCodePepper('local-compose-auth-code-pepper-4f9e1a7b2c8d0e6f', true),
    ).toThrow(ServerConfigurationError);
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
        smtpTlsMode: undefined,
        smtpUser: undefined,
        smtpPass: undefined,
        smtpFrom: undefined,
        operationTimeoutMs: undefined,
      }),
    ).toBeNull();

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: undefined,
        smtpTlsMode: 'starttls',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: 'not-a-port',
        smtpTlsMode: 'starttls',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpTlsMode: 'ssl',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: undefined,
      }),
    ).toThrow(ServerConfigurationError);

    expect(
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpTlsMode: 'STARTTLS',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: '2500',
      }),
    ).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpTlsMode: 'starttls',
      operationTimeoutMs: 2500,
      smtpUser: 'user@example.com',
      smtpPass: 'secret',
      smtpFrom: 'no-reply@example.com',
    });

    expect(
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpTlsMode: 'STARTTLS',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: undefined,
      })?.operationTimeoutMs,
    ).toBe(DEFAULT_SMTP_TIMEOUT_MS);

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpTlsMode: 'STARTTLS',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: '0',
      }),
    ).toThrow(ServerConfigurationError);
  });

  test('rejects missing or unencrypted mailer configuration in production', () => {
    expect(() => assertProductionMailerConfig(null)).toThrow(ServerConfigurationError);

    expect(() =>
      assertProductionMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: 1025,
        smtpTlsMode: 'none',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: DEFAULT_SMTP_TIMEOUT_MS,
      }),
    ).toThrow(ServerConfigurationError);

    expect(() =>
      assertProductionMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpTlsMode: 'starttls',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        operationTimeoutMs: DEFAULT_SMTP_TIMEOUT_MS,
      }),
    ).not.toThrow();
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
        operationTimeoutMs: undefined,
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
        operationTimeoutMs: undefined,
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
        operationTimeoutMs: undefined,
      }),
    ).toEqual({
      endpoint: 'http://localhost:9000',
      publicUrl: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'fairplay-user-media',
      accessKey: 'fairplay',
      secretKey: 'fairplay-minio-secret',
      signedUrlTtlSeconds: 900,
      operationTimeoutMs: DEFAULT_OBJECT_STORAGE_TIMEOUT_MS,
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
        operationTimeoutMs: '2500',
      }),
    ).toEqual({
      endpoint: 'http://minio:9000',
      publicUrl: 'http://minio:9000',
      region: 'eu-west-3',
      bucket: 'fairplay-media',
      accessKey: 'fairplay',
      secretKey: 'fairplay-minio-secret',
      signedUrlTtlSeconds: 60,
      operationTimeoutMs: 2500,
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
        operationTimeoutMs: undefined,
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
        operationTimeoutMs: undefined,
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
        operationTimeoutMs: undefined,
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
        signedUrlTtlSeconds: undefined,
        operationTimeoutMs: '0',
      }),
    ).toThrow(ServerConfigurationError);
  });

  test('parses video upload configuration', () => {
    expect(
      parseVideoUploadConfig({
        objectStorageBucket: undefined,
        partSizeBytes: undefined,
        maxPartCount: undefined,
        maxUploadBytes: undefined,
        userStorageQuotaBytes: undefined,
        sessionTtlSeconds: undefined,
      }),
    ).toEqual({
      objectStorageBucket: DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET,
      partSizeBytes: DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES,
      maxPartCount: DEFAULT_VIDEO_UPLOAD_MAX_PARTS,
      maxUploadBytes: DEFAULT_VIDEO_UPLOAD_MAX_BYTES,
      userStorageQuotaBytes: DEFAULT_VIDEO_USER_STORAGE_QUOTA_BYTES,
      sessionTtlSeconds: DEFAULT_VIDEO_UPLOAD_SESSION_TTL_SECONDS,
    });

    expect(
      parseVideoUploadConfig({
        objectStorageBucket: 'fairplay-videos',
        partSizeBytes: String(95 * 1024 * 1024),
        maxPartCount: '5000',
        maxUploadBytes: String(4 * 1024 * 1024 * 1024),
        userStorageQuotaBytes: String(10 * 1024 * 1024 * 1024),
        sessionTtlSeconds: '3600',
      }),
    ).toEqual({
      objectStorageBucket: 'fairplay-videos',
      partSizeBytes: 95 * 1024 * 1024,
      maxPartCount: 5000,
      maxUploadBytes: 4 * 1024 * 1024 * 1024,
      userStorageQuotaBytes: 10 * 1024 * 1024 * 1024,
      sessionTtlSeconds: 3600,
    });

    expect(() =>
      parseVideoUploadConfig({
        objectStorageBucket: 'Invalid_Bucket',
        partSizeBytes: undefined,
        maxPartCount: undefined,
        maxUploadBytes: undefined,
        userStorageQuotaBytes: undefined,
        sessionTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);
    expect(() =>
      parseVideoUploadConfig({
        objectStorageBucket: undefined,
        partSizeBytes: String(100 * 1024 * 1024),
        maxPartCount: undefined,
        maxUploadBytes: undefined,
        userStorageQuotaBytes: undefined,
        sessionTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);
    expect(() =>
      parseVideoUploadConfig({
        objectStorageBucket: undefined,
        partSizeBytes: undefined,
        maxPartCount: '10001',
        maxUploadBytes: undefined,
        userStorageQuotaBytes: undefined,
        sessionTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);
    expect(() =>
      parseVideoUploadConfig({
        objectStorageBucket: undefined,
        partSizeBytes: undefined,
        maxPartCount: undefined,
        maxUploadBytes: '1024',
        userStorageQuotaBytes: '512',
        sessionTtlSeconds: undefined,
      }),
    ).toThrow(ServerConfigurationError);
  });

  test('parses strict per-process video transcode limits', () => {
    expect(
      parseVideoTranscodeConfig({
        maxConcurrentJobs: undefined,
        threadsPerJob: undefined,
      }),
    ).toEqual({
      maxConcurrentJobs: DEFAULT_VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
      threadsPerJob: DEFAULT_VIDEO_TRANSCODE_THREADS_PER_JOB,
    });
    expect(
      parseVideoTranscodeConfig({
        maxConcurrentJobs: '0',
        threadsPerJob: '4',
      }),
    ).toEqual({
      maxConcurrentJobs: 0,
      threadsPerJob: 4,
    });

    for (const invalidValue of ['-1', '1.5', '1e2', '+1']) {
      expect(() =>
        parseVideoTranscodeConfig({
          maxConcurrentJobs: invalidValue,
          threadsPerJob: '2',
        }),
      ).toThrow(ServerConfigurationError);
    }

    for (const invalidValue of ['0', '-1', '1.5', '1e2', '+1']) {
      expect(() =>
        parseVideoTranscodeConfig({
          maxConcurrentJobs: '1',
          threadsPerJob: invalidValue,
        }),
      ).toThrow(ServerConfigurationError);
    }
  });
});
