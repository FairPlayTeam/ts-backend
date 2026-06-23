import {
  DAYS_MS,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  DEFAULT_OBJECT_STORAGE_BUCKET,
  DEFAULT_OBJECT_STORAGE_REGION,
  DEFAULT_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
  DEFAULT_PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  MINUTE_MS,
  SESSION_CLEANUP_INACTIVE_RETENTION_DAYS,
  SESSION_CLEANUP_INTERVAL_MINUTES,
} from './constants.js';
import type { MailerConfig } from '../services/mailer/mailer.types.js';

const HTTP_URL_PROTOCOLS = ['http:', 'https:'] as const;
const REDIS_URL_PROTOCOLS = ['redis:', 'rediss:'] as const;
const MAX_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export type TrustProxySetting = boolean | number | string | string[];

export type ObjectStorageConfig = {
  endpoint: string;
  publicUrl: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  signedUrlTtlSeconds: number;
};

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigurationError';
  }
}

export const readRequiredEnv = (value: string | undefined, name: string): string => {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    throw new ServerConfigurationError(`${name} is required`);
  }

  return trimmedValue;
};

export const parseServerPort = (rawData: string | undefined, fallback = 3000): number => {
  const value = rawData ?? String(fallback);
  const parsedPort = Number(value);

  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new ServerConfigurationError(
      `PORT must be an integer between 1 and 65535, got: ${value}`,
    );
  }

  return parsedPort;
};

export const parseBcryptRounds = (rawData: string | undefined, fallback = 12): number => {
  const value = rawData ?? String(fallback);
  const rounds = Number(value);

  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    throw new ServerConfigurationError(
      `BCRYPT_ROUNDS must be an integer between 4 and 31, got: ${value}`,
    );
  }

  return rounds;
};

const formatProtocols = (protocols: readonly string[]): string =>
  protocols.map((protocol) => protocol.replace(/:$/, '')).join(', ');

const assertUrlProtocol = (url: URL, allowedProtocols: readonly string[], name: string): void => {
  if (!allowedProtocols.includes(url.protocol)) {
    throw new ServerConfigurationError(
      `${name} must use one of these URL protocols: ${formatProtocols(allowedProtocols)}`,
    );
  }
};

const parseUrlWithProtocols = (
  rawData: string | undefined,
  name: string,
  allowedProtocols: readonly string[],
): string => {
  const value = readRequiredEnv(rawData, name);

  try {
    const url = new URL(value);
    assertUrlProtocol(url, allowedProtocols, name);
    return url.toString();
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      throw error;
    }

    throw new ServerConfigurationError(`${name} must be a valid URL, got: ${value}`);
  }
};

export const parseRequiredHttpUrl = (rawData: string | undefined, name: string): string =>
  parseUrlWithProtocols(rawData, name, HTTP_URL_PROTOCOLS);

export const parseRequiredHttpOriginUrl = (rawData: string | undefined, name: string): string => {
  const parsedUrl = new URL(parseRequiredHttpUrl(rawData, name));

  if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    throw new ServerConfigurationError(`${name} must be an HTTP(S) origin without path or query`);
  }

  return parsedUrl.origin;
};

export const parseRedisUrl = (rawData: string | undefined, name: string): string =>
  parseUrlWithProtocols(rawData, name, REDIS_URL_PROTOCOLS);

export const parseOptionalRedisUrl = (rawData: string | undefined, name: string): string | null => {
  const value = rawData?.trim();

  if (!value) {
    return null;
  }

  return parseRedisUrl(value, name);
};

export const parseTrustProxy = (
  rawValue: string | undefined,
  nodeEnv?: string,
): TrustProxySetting => {
  const value = rawValue?.trim();

  if (!value) {
    if (nodeEnv === 'development') {
      return 'loopback';
    }

    return false;
  }

  const lowerValue = value.toLowerCase();

  if (lowerValue === 'true') {
    throw new ServerConfigurationError(
      'TRUST_PROXY=true is unsafe with IP-based rate limiting. Use false, loopback, a numeric proxy hop count such as 1, or an explicit proxy list.',
    );
  }

  if (lowerValue === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value.includes(',')) {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return entries.length > 0 ? entries : false;
  }

  return value;
};

const parseBodySizeLimitBytes = (
  rawValue: string | undefined,
  fallback: number,
  envName: string,
): number => {
  const value = rawValue?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ServerConfigurationError(
      `${envName} must be a positive integer number of bytes, got: ${value}`,
    );
  }

  return parsed;
};

export const parseJsonBodyLimitBytes = (rawValue: string | undefined): number =>
  parseBodySizeLimitBytes(rawValue, DEFAULT_JSON_BODY_LIMIT_BYTES, 'JSON_BODY_LIMIT_BYTES');

export const parseProfileMediaMaxUploadBytes = (rawValue: string | undefined): number =>
  parseBodySizeLimitBytes(
    rawValue,
    DEFAULT_PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    'PROFILE_MEDIA_MAX_UPLOAD_BYTES',
  );

const parsePositiveInteger = (
  rawValue: string | undefined,
  fallback: number,
  envName: string,
  unitName: string,
  max?: number,
): number => {
  const value = rawValue?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    const range = max === undefined ? 'positive' : `between 1 and ${max}`;

    throw new ServerConfigurationError(
      `${envName} must be a ${range} integer number of ${unitName}, got: ${value}`,
    );
  }

  return parsed;
};

export const parseSessionCleanupIntervalMs = (rawValue: string | undefined): number =>
  parsePositiveInteger(
    rawValue,
    SESSION_CLEANUP_INTERVAL_MINUTES,
    'SESSION_CLEANUP_INTERVAL_MINUTES',
    'minutes',
  ) * MINUTE_MS;

export const parseSessionCleanupInactiveRetentionMs = (rawValue: string | undefined): number =>
  parsePositiveInteger(
    rawValue,
    SESSION_CLEANUP_INACTIVE_RETENTION_DAYS,
    'SESSION_CLEANUP_INACTIVE_RETENTION_DAYS',
    'days',
  ) * DAYS_MS;

export const parseIsProduction = (rawValue: string | undefined): boolean =>
  rawValue === 'production';

export const ALL_CORS_ORIGINS = '*' as const;

export type AllowedCorsOrigins = typeof ALL_CORS_ORIGINS | string[];

export const parseAllowedOrigins = (rawValue: string | undefined): AllowedCorsOrigins => {
  const value = rawValue?.trim();

  if (!value) {
    return [];
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.includes(ALL_CORS_ORIGINS)) {
    if (origins.length === 1) {
      return ALL_CORS_ORIGINS;
    }

    throw new ServerConfigurationError('CORS_ORIGINS wildcard must be used alone');
  }

  return [
    ...new Set(
      origins.map((origin) => {
        const url = new URL(parseRequiredHttpUrl(origin, 'CORS_ORIGINS entry'));

        return url.origin;
      }),
    ),
  ];
};

const DEV_RATE_LIMIT_KEY_SECRET = 'development-rate-limit-key-secret-change-me';
const PRODUCTION_RATE_LIMIT_KEY_SECRET_PLACEHOLDERS = new Set([
  DEV_RATE_LIMIT_KEY_SECRET,
  'change-me-with-at-least-32-characters',
]);

export const parseRateLimitKeySecret = (
  rawValue: string | undefined,
  isProduction: boolean,
): string => {
  const value = rawValue?.trim();

  if (!value) {
    if (isProduction) {
      throw new ServerConfigurationError('RATE_LIMIT_KEY_SECRET is required in production');
    }

    return DEV_RATE_LIMIT_KEY_SECRET;
  }

  if (value.length < 32) {
    throw new ServerConfigurationError('RATE_LIMIT_KEY_SECRET must be at least 32 characters long');
  }

  if (isProduction && PRODUCTION_RATE_LIMIT_KEY_SECRET_PLACEHOLDERS.has(value.toLowerCase())) {
    throw new ServerConfigurationError(
      'RATE_LIMIT_KEY_SECRET must not use a default placeholder in production',
    );
  }

  return value;
};

const parseObjectStorageRegion = (rawValue: string | undefined): string => {
  const value = rawValue?.trim() || DEFAULT_OBJECT_STORAGE_REGION;

  if (!/^[a-z0-9-]+$/i.test(value)) {
    throw new ServerConfigurationError(
      `OBJECT_STORAGE_REGION may only contain letters, numbers, and hyphens, got: ${value}`,
    );
  }

  return value;
};

const parseObjectStorageBucket = (rawValue: string | undefined): string => {
  const value = rawValue?.trim() || DEFAULT_OBJECT_STORAGE_BUCKET;

  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    throw new ServerConfigurationError(
      'OBJECT_STORAGE_BUCKET must be a valid S3 bucket name between 3 and 63 characters',
    );
  }

  return value;
};

type RawObjectStorageConfig = {
  endpoint: string | undefined;
  publicUrl: string | undefined;
  region: string | undefined;
  bucket: string | undefined;
  accessKey: string | undefined;
  secretKey: string | undefined;
  signedUrlTtlSeconds: string | undefined;
};

const objectStorageRequiredEnvNames = {
  endpoint: 'OBJECT_STORAGE_ENDPOINT',
  accessKey: 'OBJECT_STORAGE_ACCESS_KEY',
  secretKey: 'OBJECT_STORAGE_SECRET_KEY',
} as const satisfies Record<'endpoint' | 'accessKey' | 'secretKey', string>;

export const parseOptionalObjectStorageConfig = (
  rawConfig: RawObjectStorageConfig,
): ObjectStorageConfig | null => {
  const missingRequiredKeys = Object.entries(objectStorageRequiredEnvNames)
    .filter(([key]) => !rawConfig[key as keyof typeof objectStorageRequiredEnvNames]?.trim())
    .map(([, envName]) => envName);

  if (missingRequiredKeys.length === Object.keys(objectStorageRequiredEnvNames).length) {
    return null;
  }

  if (missingRequiredKeys.length > 0) {
    throw new ServerConfigurationError(
      `Object storage configuration is incomplete. Missing environment variables: ${missingRequiredKeys.join(', ')}`,
    );
  }

  const endpoint = parseRequiredHttpOriginUrl(rawConfig.endpoint, 'OBJECT_STORAGE_ENDPOINT');

  return {
    endpoint,
    publicUrl: parseRequiredHttpOriginUrl(
      rawConfig.publicUrl?.trim() ? rawConfig.publicUrl : endpoint,
      'OBJECT_STORAGE_PUBLIC_URL',
    ),
    region: parseObjectStorageRegion(rawConfig.region),
    bucket: parseObjectStorageBucket(rawConfig.bucket),
    accessKey: readRequiredEnv(rawConfig.accessKey, 'OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readRequiredEnv(rawConfig.secretKey, 'OBJECT_STORAGE_SECRET_KEY'),
    signedUrlTtlSeconds: parsePositiveInteger(
      rawConfig.signedUrlTtlSeconds,
      DEFAULT_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
      'OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS',
      'seconds',
      MAX_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
    ),
  };
};

const parseSmtpPort = (rawPort: string | undefined): number => {
  const value = readRequiredEnv(rawPort, 'SMTP_PORT');
  const smtpPort = Number(value);

  if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new ServerConfigurationError(`SMTP_PORT must be a valid port number, got: ${value}`);
  }

  return smtpPort;
};

const parseFrontendUrl = (rawUrl: string | undefined): string =>
  parseRequiredHttpUrl(rawUrl, 'FRONTEND_URL');

type RawMailerConfig = {
  smtpHost: string | undefined;
  smtpPort: string | undefined;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  smtpFrom: string | undefined;
  frontendUrl: string | undefined;
};

const mailerEnvNames = {
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpUser: 'SMTP_USER',
  smtpPass: 'SMTP_PASS',
  smtpFrom: 'SMTP_FROM',
  frontendUrl: 'FRONTEND_URL',
} as const satisfies Record<keyof RawMailerConfig, string>;

export const parseMailerConfig = (rawConfig: RawMailerConfig): MailerConfig | null => {
  const missingKeys = Object.entries(rawConfig)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => mailerEnvNames[key as keyof RawMailerConfig]);

  if (missingKeys.length === Object.keys(rawConfig).length) {
    return null;
  }

  if (missingKeys.length > 0) {
    throw new ServerConfigurationError(
      `Email delivery configuration is incomplete. Missing environment variables: ${missingKeys.join(', ')}`,
    );
  }

  return {
    smtpHost: readRequiredEnv(rawConfig.smtpHost, 'SMTP_HOST'),
    smtpPort: parseSmtpPort(rawConfig.smtpPort),
    smtpUser: readRequiredEnv(rawConfig.smtpUser, 'SMTP_USER'),
    smtpPass: readRequiredEnv(rawConfig.smtpPass, 'SMTP_PASS'),
    smtpFrom: readRequiredEnv(rawConfig.smtpFrom, 'SMTP_FROM'),
    frontendUrl: parseFrontendUrl(rawConfig.frontendUrl),
  };
};
