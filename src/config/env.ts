import {
  parseBcryptRounds,
  parseAllowedOrigins,
  parseMailerConfig,
  parseIsProduction,
  parseJsonBodyLimitBytes,
  parseProfileMediaMaxUploadBytes,
  parseOptionalRedisUrl,
  parseOptionalObjectStorageConfig,
  parseRateLimitKeySecret,
  parseRequiredHttpUrl,
  parseServerPort,
  parseSessionCleanupInactiveRetentionMs,
  parseSessionCleanupIntervalMs,
  parseTrustProxy,
  readRequiredEnv,
  ServerConfigurationError,
} from './env.parsers.js';

const isProduction = parseIsProduction(process.env.NODE_ENV);

const mailer = parseMailerConfig({
  smtpHost: process.env.SMTP_HOST,
  smtpPort: process.env.SMTP_PORT,
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS,
  smtpFrom: process.env.SMTP_FROM,
});

const objectStorage = parseOptionalObjectStorageConfig({
  endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
  publicUrl: process.env.OBJECT_STORAGE_PUBLIC_URL,
  region: process.env.OBJECT_STORAGE_REGION,
  bucket: process.env.OBJECT_STORAGE_BUCKET,
  accessKey: process.env.OBJECT_STORAGE_ACCESS_KEY,
  secretKey: process.env.OBJECT_STORAGE_SECRET_KEY,
  signedUrlTtlSeconds: process.env.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
});

const config = {
  port: parseServerPort(process.env.PORT),
  bcryptRounds: parseBcryptRounds(process.env.BCRYPT_ROUNDS),
  databaseUrl: readRequiredEnv(process.env.DATABASE_URL, 'DATABASE_URL'),
  baseUrl: parseRequiredHttpUrl(process.env.BASE_URL, 'BASE_URL'),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV),
  jsonBodyLimitBytes: parseJsonBodyLimitBytes(process.env.JSON_BODY_LIMIT_BYTES),
  profileMediaMaxUploadBytes: parseProfileMediaMaxUploadBytes(
    process.env.PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  ),
  isProduction,
  allowedOrigins: parseAllowedOrigins(process.env.CORS_ORIGINS),
  redisUrl: parseOptionalRedisUrl(process.env.REDIS_URL, 'REDIS_URL'),
  objectStorage,
  rateLimitKeySecret: parseRateLimitKeySecret(process.env.RATE_LIMIT_KEY_SECRET, isProduction),
  sessionCleanupIntervalMs: parseSessionCleanupIntervalMs(
    process.env.SESSION_CLEANUP_INTERVAL_MINUTES,
  ),
  sessionCleanupInactiveRetentionMs: parseSessionCleanupInactiveRetentionMs(
    process.env.SESSION_CLEANUP_INACTIVE_RETENTION_DAYS,
  ),
  mailer,
};

if (isProduction && !mailer) {
  throw new ServerConfigurationError(
    'Email delivery must be configured in production. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM.',
  );
}

if (isProduction && !config.redisUrl) {
  throw new ServerConfigurationError(
    'REDIS_URL is required in production for distributed rate limiting.',
  );
}

if (isProduction && !config.objectStorage) {
  throw new ServerConfigurationError(
    'Object storage must be configured in production. Set OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY.',
  );
}

export type Config = typeof config;

export default config;
