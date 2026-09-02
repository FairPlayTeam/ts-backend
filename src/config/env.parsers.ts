import {
  DAYS_MS,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  DEFAULT_OBJECT_STORAGE_BUCKET,
  DEFAULT_OBJECT_STORAGE_REGION,
  DEFAULT_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
  DEFAULT_OBJECT_STORAGE_TIMEOUT_MS,
  DEFAULT_PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  DEFAULT_SMTP_TIMEOUT_MS,
  DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET,
  DEFAULT_VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS,
  DEFAULT_VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS,
  DEFAULT_VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES,
  DEFAULT_VIDEO_TRANSCODE_MAX_ASPECT_RATIO,
  DEFAULT_VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
  DEFAULT_VIDEO_TRANSCODE_MAX_DURATION_SECONDS,
  DEFAULT_VIDEO_TRANSCODE_MAX_FPS,
  DEFAULT_VIDEO_TRANSCODE_MAX_HEIGHT,
  DEFAULT_VIDEO_TRANSCODE_MAX_PIXELS,
  DEFAULT_VIDEO_TRANSCODE_MAX_WIDTH,
  DEFAULT_VIDEO_TRANSCODE_THREADS_PER_JOB,
  DEFAULT_VIDEO_UPLOAD_MAX_BYTES,
  DEFAULT_VIDEO_UPLOAD_MAX_PARTS,
  DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES,
  DEFAULT_VIDEO_UPLOAD_SESSION_TTL_SECONDS,
  DEFAULT_VIDEO_USER_STORAGE_QUOTA_BYTES,
  MAX_EXTERNAL_OPERATION_TIMEOUT_MS,
  MINUTE_MS,
  SESSION_CLEANUP_INACTIVE_RETENTION_DAYS,
  SESSION_CLEANUP_INTERVAL_MINUTES,
} from './constants.js';
import {
  SMTP_TLS_MODES,
  type MailerConfig,
  type SmtpTlsMode,
} from '../services/mailer/mailer.types.js';

const HTTP_URL_PROTOCOLS = ['http:', 'https:'] as const;
const REDIS_URL_PROTOCOLS = ['redis:', 'rediss:'] as const;
const MAX_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_VIDEO_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_PART_SIZE_BYTES = 99_999_999;
const MAX_VIDEO_UPLOAD_PARTS = 10_000;
const MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS = 7 * DAYS_MS;
const MAX_VIDEO_TRANSCODE_PIXELS = 2_147_483_647;

type TrustProxySetting = boolean | number | string | string[];

export type ObjectStorageConfig = {
  endpoint: string;
  publicUrl: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  signedUrlTtlSeconds: number;
  operationTimeoutMs: number;
};

export type VideoUploadConfig = {
  objectStorageBucket: string;
  partSizeBytes: number;
  maxPartCount: number;
  maxUploadBytes: number;
  userStorageQuotaBytes: number;
  sessionTtlSeconds: number;
};

type VideoTranscodeConfig = {
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  maxArtifactBytes: number;
  maxAspectRatio: number;
  maxConcurrentJobs: number;
  maxDurationSeconds: number;
  maxFps: number;
  maxHeight: number;
  maxPixels: number;
  maxWidth: number;
  threadsPerJob: number;
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

const parseRedisUrl = (rawData: string | undefined, name: string): string =>
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

  if (
    !/^[1-9]\d*$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    (max !== undefined && parsed > max)
  ) {
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

const parseExternalOperationTimeoutMs = (
  rawValue: string | undefined,
  fallback: number,
  envName: string,
): number =>
  parsePositiveInteger(
    rawValue,
    fallback,
    envName,
    'milliseconds',
    MAX_EXTERNAL_OPERATION_TIMEOUT_MS,
  );

export const parseIsProduction = (rawValue: string | undefined): boolean =>
  rawValue === 'production';

export const ALL_CORS_ORIGINS = '*' as const;

type AllowedCorsOrigins = typeof ALL_CORS_ORIGINS | string[];

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
const DEV_AUTH_CODE_PEPPER = 'development-auth-code-pepper-change-me';
const PRODUCTION_AUTH_CODE_PEPPER_PLACEHOLDERS = new Set([
  DEV_AUTH_CODE_PEPPER,
  'change-me-auth-code-pepper-32-characters',
  'local-compose-auth-code-pepper-4f9e1a7b2c8d0e6f',
]);

const parseSecret = ({
  rawValue,
  envName,
  isProduction,
  developmentFallback,
  productionPlaceholders,
}: {
  rawValue: string | undefined;
  envName: string;
  isProduction: boolean;
  developmentFallback: string;
  productionPlaceholders: ReadonlySet<string>;
}): string => {
  const value = rawValue?.trim();

  if (!value) {
    if (isProduction) {
      throw new ServerConfigurationError(`${envName} is required in production`);
    }

    return developmentFallback;
  }

  if (value.length < 32) {
    throw new ServerConfigurationError(`${envName} must be at least 32 characters long`);
  }

  if (isProduction && productionPlaceholders.has(value.toLowerCase())) {
    throw new ServerConfigurationError(
      `${envName} must not use a default placeholder in production`,
    );
  }

  return value;
};

export const parseRateLimitKeySecret = (
  rawValue: string | undefined,
  isProduction: boolean,
): string =>
  parseSecret({
    rawValue,
    envName: 'RATE_LIMIT_KEY_SECRET',
    isProduction,
    developmentFallback: DEV_RATE_LIMIT_KEY_SECRET,
    productionPlaceholders: PRODUCTION_RATE_LIMIT_KEY_SECRET_PLACEHOLDERS,
  });

export const parseAuthCodePepper = (rawValue: string | undefined, isProduction: boolean): string =>
  parseSecret({
    rawValue,
    envName: 'AUTH_CODE_PEPPER',
    isProduction,
    developmentFallback: DEV_AUTH_CODE_PEPPER,
    productionPlaceholders: PRODUCTION_AUTH_CODE_PEPPER_PLACEHOLDERS,
  });

const parseObjectStorageRegion = (rawValue: string | undefined): string => {
  const value = rawValue?.trim() || DEFAULT_OBJECT_STORAGE_REGION;

  if (!/^[a-z0-9-]+$/i.test(value)) {
    throw new ServerConfigurationError(
      `OBJECT_STORAGE_REGION may only contain letters, numbers, and hyphens, got: ${value}`,
    );
  }

  return value;
};

const parseObjectStorageBucket = (
  rawValue: string | undefined,
  envName = 'OBJECT_STORAGE_BUCKET',
  fallback = DEFAULT_OBJECT_STORAGE_BUCKET,
): string => {
  const value = rawValue?.trim() || fallback;

  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes('..') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    throw new ServerConfigurationError(
      `${envName} must be a valid S3 bucket name between 3 and 63 characters`,
    );
  }

  return value;
};

const parseVideoUploadPartSizeBytes = (rawValue: string | undefined): number => {
  const value = rawValue?.trim();

  if (!value) {
    return DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES;
  }

  const parsed = Number(value);

  if (
    !/^[1-9]\d*$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_VIDEO_UPLOAD_PART_SIZE_BYTES ||
    parsed > MAX_VIDEO_UPLOAD_PART_SIZE_BYTES
  ) {
    throw new ServerConfigurationError(
      `VIDEO_UPLOAD_PART_SIZE_BYTES must be an integer between ${MIN_VIDEO_UPLOAD_PART_SIZE_BYTES} and ${MAX_VIDEO_UPLOAD_PART_SIZE_BYTES} bytes, got: ${value}`,
    );
  }

  return parsed;
};

type RawObjectStorageConfig = {
  endpoint: string | undefined;
  publicUrl: string | undefined;
  region: string | undefined;
  bucket: string | undefined;
  accessKey: string | undefined;
  secretKey: string | undefined;
  signedUrlTtlSeconds: string | undefined;
  operationTimeoutMs: string | undefined;
};

type RawVideoUploadConfig = {
  objectStorageBucket: string | undefined;
  partSizeBytes: string | undefined;
  maxPartCount: string | undefined;
  maxUploadBytes: string | undefined;
  userStorageQuotaBytes: string | undefined;
  sessionTtlSeconds: string | undefined;
};

type RawVideoTranscodeConfig = {
  ffmpegTimeoutMs: string | undefined;
  ffprobeTimeoutMs: string | undefined;
  maxArtifactBytes: string | undefined;
  maxAspectRatio: string | undefined;
  maxConcurrentJobs: string | undefined;
  maxDurationSeconds: string | undefined;
  maxFps: string | undefined;
  maxHeight: string | undefined;
  maxPixels: string | undefined;
  maxWidth: string | undefined;
  threadsPerJob: string | undefined;
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
    operationTimeoutMs: parseExternalOperationTimeoutMs(
      rawConfig.operationTimeoutMs,
      DEFAULT_OBJECT_STORAGE_TIMEOUT_MS,
      'OBJECT_STORAGE_TIMEOUT_MS',
    ),
  };
};

export const parseVideoUploadConfig = (rawConfig: RawVideoUploadConfig): VideoUploadConfig => {
  const config = {
    objectStorageBucket: parseObjectStorageBucket(
      rawConfig.objectStorageBucket,
      'VIDEO_OBJECT_STORAGE_BUCKET',
      DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET,
    ),
    partSizeBytes: parseVideoUploadPartSizeBytes(rawConfig.partSizeBytes),
    maxPartCount: parsePositiveInteger(
      rawConfig.maxPartCount,
      DEFAULT_VIDEO_UPLOAD_MAX_PARTS,
      'VIDEO_UPLOAD_MAX_PARTS',
      'parts',
      MAX_VIDEO_UPLOAD_PARTS,
    ),
    maxUploadBytes: parsePositiveInteger(
      rawConfig.maxUploadBytes,
      DEFAULT_VIDEO_UPLOAD_MAX_BYTES,
      'VIDEO_UPLOAD_MAX_BYTES',
      'bytes',
      Number.MAX_SAFE_INTEGER,
    ),
    userStorageQuotaBytes: parsePositiveInteger(
      rawConfig.userStorageQuotaBytes,
      DEFAULT_VIDEO_USER_STORAGE_QUOTA_BYTES,
      'VIDEO_USER_STORAGE_QUOTA_BYTES',
      'bytes',
      Number.MAX_SAFE_INTEGER,
    ),
    sessionTtlSeconds: parsePositiveInteger(
      rawConfig.sessionTtlSeconds,
      DEFAULT_VIDEO_UPLOAD_SESSION_TTL_SECONDS,
      'VIDEO_UPLOAD_SESSION_TTL_SECONDS',
      'seconds',
    ),
  };

  if (config.maxUploadBytes > config.partSizeBytes * config.maxPartCount) {
    throw new ServerConfigurationError(
      'VIDEO_UPLOAD_MAX_BYTES exceeds the configured multipart part size and part count capacity',
    );
  }

  if (config.userStorageQuotaBytes < config.maxUploadBytes) {
    throw new ServerConfigurationError(
      'VIDEO_USER_STORAGE_QUOTA_BYTES must be greater than or equal to VIDEO_UPLOAD_MAX_BYTES',
    );
  }

  return config;
};

const parseNonNegativeInteger = (
  rawValue: string | undefined,
  fallback: number,
  envName: string,
): number => {
  const value = rawValue?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(parsed)) {
    throw new ServerConfigurationError(`${envName} must be a non-negative integer, got: ${value}`);
  }

  return parsed;
};

export const parseVideoTranscodeConfig = (
  rawConfig: RawVideoTranscodeConfig,
): VideoTranscodeConfig => ({
  maxConcurrentJobs: parseNonNegativeInteger(
    rawConfig.maxConcurrentJobs,
    DEFAULT_VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
    'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS',
  ),
  threadsPerJob: parsePositiveInteger(
    rawConfig.threadsPerJob,
    DEFAULT_VIDEO_TRANSCODE_THREADS_PER_JOB,
    'VIDEO_TRANSCODE_THREADS_PER_JOB',
    'threads',
  ),
  maxDurationSeconds: parsePositiveInteger(
    rawConfig.maxDurationSeconds,
    DEFAULT_VIDEO_TRANSCODE_MAX_DURATION_SECONDS,
    'VIDEO_TRANSCODE_MAX_DURATION_SECONDS',
    'seconds',
  ),
  maxWidth: parsePositiveInteger(
    rawConfig.maxWidth,
    DEFAULT_VIDEO_TRANSCODE_MAX_WIDTH,
    'VIDEO_TRANSCODE_MAX_WIDTH',
    'pixels',
  ),
  maxHeight: parsePositiveInteger(
    rawConfig.maxHeight,
    DEFAULT_VIDEO_TRANSCODE_MAX_HEIGHT,
    'VIDEO_TRANSCODE_MAX_HEIGHT',
    'pixels',
  ),
  maxPixels: parsePositiveInteger(
    rawConfig.maxPixels,
    DEFAULT_VIDEO_TRANSCODE_MAX_PIXELS,
    'VIDEO_TRANSCODE_MAX_PIXELS',
    'pixels',
    MAX_VIDEO_TRANSCODE_PIXELS,
  ),
  maxAspectRatio: parsePositiveInteger(
    rawConfig.maxAspectRatio,
    DEFAULT_VIDEO_TRANSCODE_MAX_ASPECT_RATIO,
    'VIDEO_TRANSCODE_MAX_ASPECT_RATIO',
    'ratio units',
  ),
  maxFps: parsePositiveInteger(
    rawConfig.maxFps,
    DEFAULT_VIDEO_TRANSCODE_MAX_FPS,
    'VIDEO_TRANSCODE_MAX_FPS',
    'frames per second',
  ),
  ffprobeTimeoutMs: parsePositiveInteger(
    rawConfig.ffprobeTimeoutMs,
    DEFAULT_VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS,
    'VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS',
    'milliseconds',
    MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS,
  ),
  ffmpegTimeoutMs: parsePositiveInteger(
    rawConfig.ffmpegTimeoutMs,
    DEFAULT_VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS,
    'VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS',
    'milliseconds',
    MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS,
  ),
  maxArtifactBytes: parsePositiveInteger(
    rawConfig.maxArtifactBytes,
    DEFAULT_VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES,
    'VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES',
    'bytes',
  ),
});

const parseSmtpPort = (rawPort: string | undefined): number => {
  const value = readRequiredEnv(rawPort, 'SMTP_PORT');
  const smtpPort = Number(value);

  if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new ServerConfigurationError(`SMTP_PORT must be a valid port number, got: ${value}`);
  }

  return smtpPort;
};

const parseSmtpTlsMode = (rawMode: string | undefined): SmtpTlsMode => {
  const value = readRequiredEnv(rawMode, 'SMTP_TLS_MODE').toLowerCase();

  if (!SMTP_TLS_MODES.includes(value as SmtpTlsMode)) {
    throw new ServerConfigurationError(
      `SMTP_TLS_MODE must be one of: ${SMTP_TLS_MODES.join(', ')}`,
    );
  }

  return value as SmtpTlsMode;
};

type RawMailerConfig = {
  smtpHost: string | undefined;
  smtpPort: string | undefined;
  smtpTlsMode: string | undefined;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  smtpFrom: string | undefined;
  operationTimeoutMs: string | undefined;
};

const mailerEnvNames = {
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpTlsMode: 'SMTP_TLS_MODE',
  smtpUser: 'SMTP_USER',
  smtpPass: 'SMTP_PASS',
  smtpFrom: 'SMTP_FROM',
} as const satisfies Record<Exclude<keyof RawMailerConfig, 'operationTimeoutMs'>, string>;

export const parseMailerConfig = (rawConfig: RawMailerConfig): MailerConfig | null => {
  const requiredConfig = {
    smtpHost: rawConfig.smtpHost,
    smtpPort: rawConfig.smtpPort,
    smtpTlsMode: rawConfig.smtpTlsMode,
    smtpUser: rawConfig.smtpUser,
    smtpPass: rawConfig.smtpPass,
    smtpFrom: rawConfig.smtpFrom,
  };
  const missingKeys = Object.entries(requiredConfig)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => mailerEnvNames[key as keyof typeof requiredConfig]);

  if (missingKeys.length === Object.keys(requiredConfig).length) {
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
    smtpTlsMode: parseSmtpTlsMode(rawConfig.smtpTlsMode),
    operationTimeoutMs: parseExternalOperationTimeoutMs(
      rawConfig.operationTimeoutMs,
      DEFAULT_SMTP_TIMEOUT_MS,
      'SMTP_TIMEOUT_MS',
    ),
    smtpUser: readRequiredEnv(rawConfig.smtpUser, 'SMTP_USER'),
    smtpPass: readRequiredEnv(rawConfig.smtpPass, 'SMTP_PASS'),
    smtpFrom: readRequiredEnv(rawConfig.smtpFrom, 'SMTP_FROM'),
  };
};

export const assertProductionMailerConfig = (mailer: MailerConfig | null): void => {
  if (!mailer) {
    throw new ServerConfigurationError(
      'Email delivery must be configured in production. Set SMTP_HOST, SMTP_PORT, SMTP_TLS_MODE, SMTP_USER, SMTP_PASS, and SMTP_FROM.',
    );
  }

  if (mailer.smtpTlsMode === 'none') {
    throw new ServerConfigurationError('SMTP_TLS_MODE=none is not allowed in production');
  }
};
