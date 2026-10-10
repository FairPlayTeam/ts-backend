import { z } from 'zod';
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
  DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS,
  DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER,
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
import { SMTP_TLS_MODES } from '../services/mailer/mailer.types.js';

const optionalString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}, z.string().optional());

const requiredString = (name: string) =>
  optionalString.transform((value, context) => {
    if (value !== undefined) return value;
    context.addIssue({ code: 'custom', message: `${name} is required` });
    return '';
  });

const positiveInteger = (fallback: number, maximum?: number) =>
  optionalString.transform((value, context) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (
      !/^[1-9]\d*$/u.test(value) ||
      !Number.isSafeInteger(parsed) ||
      (maximum !== undefined && parsed > maximum)
    ) {
      context.addIssue({ code: 'custom', message: 'Must be a positive safe integer' });
      return fallback;
    }
    return parsed;
  });

const nonNegativeInteger = (fallback: number) =>
  optionalString.transform((value, context) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(parsed)) {
      context.addIssue({
        code: 'custom',
        message: 'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS must be a non-negative safe integer',
      });
      return fallback;
    }
    return parsed;
  });

const numberWithDefault = (
  name: string,
  fallback: number,
  minimum: number,
  maximum?: number,
  blankUsesDefault = false,
  errorMessage?: string,
) =>
  z
    .string()
    .optional()
    .transform((rawValue, context) => {
      const trimmedValue = rawValue?.trim();
      const value =
        blankUsesDefault && !trimmedValue ? String(fallback) : (rawValue ?? String(fallback));
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < minimum ||
        (maximum !== undefined && parsed > maximum)
      ) {
        const range =
          maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
        context.addIssue({
          code: 'custom',
          message: errorMessage ?? `${name} must be an integer ${range}`,
        });
        return fallback;
      }
      return parsed;
    });

const bodySize = (name: string, fallback: number) =>
  numberWithDefault(
    name,
    fallback,
    1,
    undefined,
    true,
    `${name} must be a positive integer number of bytes`,
  );

const positiveIntegerAtLeast = (fallback: number, minimum: number, maximum?: number) =>
  positiveInteger(fallback, maximum).refine((value) => value >= minimum, {
    message: `Must be an integer of at least ${minimum}`,
  });

const urlWithProtocols = (protocols: readonly string[]) =>
  optionalString.transform((value, context) => {
    if (value === undefined) {
      context.addIssue({ code: 'custom', message: 'URL is required' });
      return '';
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Must be a valid URL' });
      return '';
    }
    if (!protocols.includes(url.protocol)) {
      context.addIssue({ code: 'custom', message: 'URL protocol is not allowed' });
      return '';
    }
    return url.toString();
  });

const optionalUrlWithProtocols = (protocols: readonly string[]) =>
  optionalString.transform((value, context) => {
    if (value === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Must be a valid URL' });
      return undefined;
    }
    if (!protocols.includes(url.protocol)) {
      context.addIssue({ code: 'custom', message: 'URL protocol is not allowed' });
      return undefined;
    }
    return url.toString();
  });

const httpOrigin = optionalString.transform((value, context) => {
  if (value === undefined) {
    context.addIssue({ code: 'custom', message: 'HTTP(S) origin is required' });
    return '';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Must be a valid HTTP(S) origin' });
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: 'custom', message: 'Origin protocol must be HTTP or HTTPS' });
    return '';
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'Origin cannot contain a path, query, or fragment',
    });
    return '';
  }
  return url.origin;
});

const secretWithMinimumLength = (minimumLength: number) =>
  optionalString.refine((value) => value === undefined || value.length >= minimumLength, {
    message: `Secret must contain at least ${minimumLength} characters`,
  });

const HTTP_PROTOCOLS: readonly string[] = z.enum(['http:', 'https:']).options;
const REDIS_PROTOCOLS: readonly string[] = z.enum(['redis:', 'rediss:']).options;
const runtimeRoleSchema = z.enum(['api', 'transcoder', 'combined']);
export const RUNTIME_ROLES = runtimeRoleSchema.options;
export const ALL_CORS_ORIGINS = z.literal('*').value;

const OBJECT_STORAGE_SIGNED_URL_MAX_SECONDS = 7 * 24 * 60 * 60;
const MIN_VIDEO_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_PART_SIZE_BYTES = 99_999_999;
const MAX_VIDEO_UPLOAD_PARTS = 10_000;
const MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VIDEO_TRANSCODE_PIXELS = 2_147_483_647;

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
const DEV_FOLLOWING_CURSOR_ENCRYPTION_KEY =
  '646576656c6f706d656e742d666f6c6c6f77696e672d637572736f722d6b6579';
const PRODUCTION_FOLLOWING_CURSOR_ENCRYPTION_KEY_PLACEHOLDERS = new Set([
  DEV_FOLLOWING_CURSOR_ENCRYPTION_KEY,
  '0000000000000000000000000000000000000000000000000000000000000000',
  '78c1c8d89b9982db066232c742118a9dd8263a8f0671f840a88f45c595c45d8f',
]);

const corsOrigins = optionalString.transform(
  (value, context): typeof ALL_CORS_ORIGINS | string[] => {
    if (value === undefined) return [];
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
    if (origins.includes(ALL_CORS_ORIGINS)) {
      if (origins.length === 1) return ALL_CORS_ORIGINS;
      context.addIssue({ code: 'custom', message: 'CORS_ORIGINS wildcard must be used alone' });
      return [];
    }
    return [
      ...new Set(
        origins.map((origin) => {
          try {
            const url = new URL(origin);
            if (!HTTP_PROTOCOLS.includes(url.protocol)) throw new Error();
            return url.origin;
          } catch {
            context.addIssue({
              code: 'custom',
              message: 'CORS_ORIGINS entries must be valid HTTP(S) URLs',
            });
            return '';
          }
        }),
      ),
    ];
  },
);

const environmentSchemaFields = z.object({
  NODE_ENV: z.string().optional(),
  RUNTIME_ROLE: optionalString,
  PORT: numberWithDefault('PORT', 3000, 1, 65535),
  BCRYPT_ROUNDS: numberWithDefault('BCRYPT_ROUNDS', 12, 4, 31),
  DATABASE_URL: requiredString('DATABASE_URL'),
  BASE_URL: urlWithProtocols(HTTP_PROTOCOLS),
  JSON_BODY_LIMIT_BYTES: bodySize('JSON_BODY_LIMIT_BYTES', DEFAULT_JSON_BODY_LIMIT_BYTES),
  PROFILE_MEDIA_MAX_UPLOAD_BYTES: bodySize(
    'PROFILE_MEDIA_MAX_UPLOAD_BYTES',
    DEFAULT_PROFILE_MEDIA_MAX_UPLOAD_BYTES,
  ),
  TRUST_PROXY: optionalString,
  CORS_ORIGINS: corsOrigins,
  REDIS_URL: optionalUrlWithProtocols(REDIS_PROTOCOLS),
  RATE_LIMIT_KEY_SECRET: secretWithMinimumLength(32),
  AUTH_CODE_PEPPER: secretWithMinimumLength(32),
  FOLLOWING_CURSOR_ENCRYPTION_KEY: optionalString,
  SESSION_CLEANUP_INTERVAL_MINUTES: positiveInteger(SESSION_CLEANUP_INTERVAL_MINUTES),
  SESSION_CLEANUP_INACTIVE_RETENTION_DAYS: positiveInteger(SESSION_CLEANUP_INACTIVE_RETENTION_DAYS),
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalString,
  SMTP_TLS_MODE: optionalString,
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: optionalString,
  SMTP_TIMEOUT_MS: optionalString,
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_PUBLIC_URL: optionalString,
  OBJECT_STORAGE_REGION: optionalString,
  OBJECT_STORAGE_BUCKET: optionalString,
  OBJECT_STORAGE_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_SECRET_KEY: optionalString,
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: optionalString,
  OBJECT_STORAGE_TIMEOUT_MS: optionalString,
  VIDEO_OBJECT_STORAGE_BUCKET: optionalString.transform((value, context) => {
    const bucket = value ?? DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET;
    if (
      bucket.length < 3 ||
      bucket.length > 63 ||
      !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket) ||
      bucket.includes('..') ||
      /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'VIDEO_OBJECT_STORAGE_BUCKET must be a valid S3 bucket name between 3 and 63 characters',
      });
      return DEFAULT_VIDEO_OBJECT_STORAGE_BUCKET;
    }
    return bucket;
  }),
  VIDEO_UPLOAD_PART_SIZE_BYTES: positiveIntegerAtLeast(
    DEFAULT_VIDEO_UPLOAD_PART_SIZE_BYTES,
    MIN_VIDEO_UPLOAD_PART_SIZE_BYTES,
    MAX_VIDEO_UPLOAD_PART_SIZE_BYTES,
  ),
  VIDEO_UPLOAD_MAX_PARTS: positiveInteger(DEFAULT_VIDEO_UPLOAD_MAX_PARTS, MAX_VIDEO_UPLOAD_PARTS),
  VIDEO_UPLOAD_MAX_BYTES: positiveInteger(DEFAULT_VIDEO_UPLOAD_MAX_BYTES, Number.MAX_SAFE_INTEGER),
  VIDEO_USER_STORAGE_QUOTA_BYTES: positiveInteger(
    DEFAULT_VIDEO_USER_STORAGE_QUOTA_BYTES,
    Number.MAX_SAFE_INTEGER,
  ),
  VIDEO_UPLOAD_SESSION_TTL_SECONDS: positiveInteger(DEFAULT_VIDEO_UPLOAD_SESSION_TTL_SECONDS),
  VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS,
  ),
  VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER,
  ),
  VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: nonNegativeInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
  ),
  VIDEO_TRANSCODE_THREADS_PER_JOB: positiveInteger(DEFAULT_VIDEO_TRANSCODE_THREADS_PER_JOB),
  VIDEO_TRANSCODE_MAX_DURATION_SECONDS: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_DURATION_SECONDS,
  ),
  VIDEO_TRANSCODE_MAX_WIDTH: positiveInteger(DEFAULT_VIDEO_TRANSCODE_MAX_WIDTH),
  VIDEO_TRANSCODE_MAX_HEIGHT: positiveInteger(DEFAULT_VIDEO_TRANSCODE_MAX_HEIGHT),
  VIDEO_TRANSCODE_MAX_PIXELS: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_PIXELS,
    MAX_VIDEO_TRANSCODE_PIXELS,
  ),
  VIDEO_TRANSCODE_MAX_ASPECT_RATIO: positiveInteger(DEFAULT_VIDEO_TRANSCODE_MAX_ASPECT_RATIO),
  VIDEO_TRANSCODE_MAX_FPS: positiveInteger(DEFAULT_VIDEO_TRANSCODE_MAX_FPS),
  VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS,
    MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS,
  ),
  VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS,
    MAX_VIDEO_TRANSCODE_PROCESS_TIMEOUT_MS,
  ),
  VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES: positiveInteger(
    DEFAULT_VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES,
    Number.MAX_SAFE_INTEGER,
  ),
});

type EnvironmentFields = z.output<typeof environmentSchemaFields>;

const objectStorageConfiguredSchema = environmentSchemaFields
  .pick({
    OBJECT_STORAGE_ENDPOINT: true,
    OBJECT_STORAGE_PUBLIC_URL: true,
    OBJECT_STORAGE_REGION: true,
    OBJECT_STORAGE_BUCKET: true,
    OBJECT_STORAGE_ACCESS_KEY: true,
    OBJECT_STORAGE_SECRET_KEY: true,
    OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: true,
    OBJECT_STORAGE_TIMEOUT_MS: true,
  })
  .extend({
    OBJECT_STORAGE_ENDPOINT: httpOrigin,
    OBJECT_STORAGE_PUBLIC_URL: httpOrigin.optional(),
    OBJECT_STORAGE_REGION: optionalString.transform((value, context) => {
      const region = value ?? DEFAULT_OBJECT_STORAGE_REGION;
      if (!/^[a-z0-9-]+$/iu.test(region)) {
        context.addIssue({
          code: 'custom',
          message: 'OBJECT_STORAGE_REGION may only contain letters, numbers, and hyphens',
        });
        return DEFAULT_OBJECT_STORAGE_REGION;
      }
      return region;
    }),
    OBJECT_STORAGE_BUCKET: optionalString.transform((value, context) => {
      const bucket = value ?? DEFAULT_OBJECT_STORAGE_BUCKET;
      if (
        bucket.length < 3 ||
        bucket.length > 63 ||
        !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket) ||
        bucket.includes('..') ||
        /^\d+\.\d+\.\d+\.\d+$/u.test(bucket)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'OBJECT_STORAGE_BUCKET must be a valid S3 bucket name between 3 and 63 characters',
        });
        return DEFAULT_OBJECT_STORAGE_BUCKET;
      }
      return bucket;
    }),
    OBJECT_STORAGE_ACCESS_KEY: requiredString('OBJECT_STORAGE_ACCESS_KEY'),
    OBJECT_STORAGE_SECRET_KEY: requiredString('OBJECT_STORAGE_SECRET_KEY'),
    OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: positiveInteger(
      DEFAULT_OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
      OBJECT_STORAGE_SIGNED_URL_MAX_SECONDS,
    ),
    OBJECT_STORAGE_TIMEOUT_MS: positiveInteger(
      DEFAULT_OBJECT_STORAGE_TIMEOUT_MS,
      MAX_EXTERNAL_OPERATION_TIMEOUT_MS,
    ),
  })
  .transform((storage) => ({
    endpoint: storage.OBJECT_STORAGE_ENDPOINT,
    publicUrl: storage.OBJECT_STORAGE_PUBLIC_URL ?? storage.OBJECT_STORAGE_ENDPOINT,
    region: storage.OBJECT_STORAGE_REGION,
    bucket: storage.OBJECT_STORAGE_BUCKET,
    accessKey: storage.OBJECT_STORAGE_ACCESS_KEY,
    secretKey: storage.OBJECT_STORAGE_SECRET_KEY,
    signedUrlTtlSeconds: storage.OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS,
    operationTimeoutMs: storage.OBJECT_STORAGE_TIMEOUT_MS,
  }));

const mailerConfiguredSchema = environmentSchemaFields
  .pick({
    SMTP_HOST: true,
    SMTP_PORT: true,
    SMTP_TLS_MODE: true,
    SMTP_USER: true,
    SMTP_PASS: true,
    SMTP_FROM: true,
    SMTP_TIMEOUT_MS: true,
  })
  .extend({
    SMTP_HOST: requiredString('SMTP_HOST'),
    SMTP_PORT: optionalString.transform((value, context) => {
      const port = Number(value ?? '');
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        context.addIssue({ code: 'custom', message: 'SMTP_PORT must be a valid port number' });
        return 1;
      }
      return port;
    }),
    SMTP_TLS_MODE: optionalString.transform((value, context) => {
      const mode = z.enum(SMTP_TLS_MODES).safeParse(value?.toLowerCase());
      if (!mode.success) {
        context.addIssue({
          code: 'custom',
          message: `SMTP_TLS_MODE must be one of: ${SMTP_TLS_MODES.join(', ')}`,
        });
        return SMTP_TLS_MODES[0];
      }
      return mode.data;
    }),
    SMTP_TIMEOUT_MS: positiveInteger(DEFAULT_SMTP_TIMEOUT_MS, MAX_EXTERNAL_OPERATION_TIMEOUT_MS),
    SMTP_USER: requiredString('SMTP_USER'),
    SMTP_PASS: requiredString('SMTP_PASS'),
    SMTP_FROM: requiredString('SMTP_FROM'),
  })
  .transform((mailer) => ({
    smtpHost: mailer.SMTP_HOST,
    smtpPort: mailer.SMTP_PORT,
    smtpTlsMode: mailer.SMTP_TLS_MODE,
    operationTimeoutMs: mailer.SMTP_TIMEOUT_MS,
    smtpUser: mailer.SMTP_USER,
    smtpPass: mailer.SMTP_PASS,
    smtpFrom: mailer.SMTP_FROM,
  }));

const OBJECT_STORAGE_REQUIRED: ReadonlyArray<readonly [keyof EnvironmentFields, string]> = [
  ['OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_ENDPOINT'],
  ['OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_ACCESS_KEY'],
  ['OBJECT_STORAGE_SECRET_KEY', 'OBJECT_STORAGE_SECRET_KEY'],
];
const MAILER_REQUIRED: ReadonlyArray<readonly [keyof EnvironmentFields, string]> = [
  ['SMTP_HOST', 'SMTP_HOST'],
  ['SMTP_PORT', 'SMTP_PORT'],
  ['SMTP_TLS_MODE', 'SMTP_TLS_MODE'],
  ['SMTP_USER', 'SMTP_USER'],
  ['SMTP_PASS', 'SMTP_PASS'],
  ['SMTP_FROM', 'SMTP_FROM'],
];

const parseOptionalGroup = <T>(
  environment: EnvironmentFields,
  required: ReadonlyArray<readonly [keyof EnvironmentFields, string]>,
  schema: z.ZodType<T>,
  context: z.RefinementCtx,
  incompleteMessage: string,
): T | null => {
  const missing = required
    .filter(([field]) => environment[field] === undefined)
    .map(([, name]) => name);
  if (missing.length === required.length) return null;
  if (missing.length > 0) {
    context.addIssue({
      code: 'custom',
      message: `${incompleteMessage} Missing environment variables: ${missing.join(', ')}`,
    });
    return null;
  }
  const parsed = schema.safeParse(environment);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
  return null;
};

const addIssue = (context: z.RefinementCtx, name: string, message: string) =>
  context.addIssue({ code: 'custom', path: [name], message });

const validateCrossFieldRules = (environment: EnvironmentFields, context: z.RefinementCtx) => {
  const isProduction = environment.NODE_ENV === 'production';
  const configuredRole = environment.RUNTIME_ROLE;
  const parsedRole = configuredRole ? runtimeRoleSchema.safeParse(configuredRole) : undefined;
  const runtimeRole = parsedRole?.success ? parsedRole.data : 'combined';
  const productionApi = isProduction && runtimeRole === 'api';
  const storagePresent = OBJECT_STORAGE_REQUIRED.some(
    ([field]) => environment[field] !== undefined,
  );
  const mailerComplete = MAILER_REQUIRED.every(([field]) => environment[field] !== undefined);

  if (configuredRole && parsedRole && !parsedRole.success) {
    addIssue(context, 'RUNTIME_ROLE', `RUNTIME_ROLE must be one of: ${RUNTIME_ROLES.join(', ')}`);
  }
  if (isProduction && configuredRole === undefined) {
    addIssue(context, 'RUNTIME_ROLE', 'RUNTIME_ROLE is required in production');
  }
  if (isProduction && parsedRole?.success && parsedRole.data === 'combined') {
    addIssue(context, 'RUNTIME_ROLE', 'RUNTIME_ROLE=combined is not allowed in production');
  }
  if (runtimeRole === 'api' && environment.VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS !== 0) {
    addIssue(
      context,
      'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS',
      'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS must be 0 when RUNTIME_ROLE=api',
    );
  }
  if (runtimeRole === 'transcoder' && environment.VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS !== 1) {
    addIssue(
      context,
      'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS',
      'VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS must be 1 when RUNTIME_ROLE=transcoder',
    );
  }
  if (
    isProduction &&
    runtimeRole === 'transcoder' &&
    environment.VIDEO_TRANSCODE_THREADS_PER_JOB > 2
  ) {
    addIssue(
      context,
      'VIDEO_TRANSCODE_THREADS_PER_JOB',
      'VIDEO_TRANSCODE_THREADS_PER_JOB must be at most 2 on the production transcoder',
    );
  }

  if (
    environment.VIDEO_UPLOAD_MAX_BYTES >
    environment.VIDEO_UPLOAD_PART_SIZE_BYTES * environment.VIDEO_UPLOAD_MAX_PARTS
  ) {
    addIssue(
      context,
      'VIDEO_UPLOAD_MAX_BYTES',
      'VIDEO_UPLOAD_MAX_BYTES exceeds the configured multipart part size and part count capacity',
    );
  }
  if (environment.VIDEO_USER_STORAGE_QUOTA_BYTES < environment.VIDEO_UPLOAD_MAX_BYTES) {
    addIssue(
      context,
      'VIDEO_USER_STORAGE_QUOTA_BYTES',
      'VIDEO_USER_STORAGE_QUOTA_BYTES must be greater than or equal to VIDEO_UPLOAD_MAX_BYTES',
    );
  }

  if (isProduction && !storagePresent) {
    addIssue(
      context,
      'OBJECT_STORAGE_ENDPOINT',
      'Object storage must be configured in production. Set OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY, and OBJECT_STORAGE_SECRET_KEY.',
    );
  }
  if (productionApi) {
    if (!mailerComplete) {
      addIssue(
        context,
        'SMTP_HOST',
        'Email delivery must be configured in production. Set SMTP_HOST, SMTP_PORT, SMTP_TLS_MODE, SMTP_USER, SMTP_PASS, and SMTP_FROM.',
      );
    } else if (environment.SMTP_TLS_MODE?.toLowerCase() === 'none') {
      addIssue(context, 'SMTP_TLS_MODE', 'SMTP_TLS_MODE=none is not allowed in production');
    }
    if (environment.REDIS_URL === undefined) {
      addIssue(
        context,
        'REDIS_URL',
        'REDIS_URL is required in production for distributed rate limiting.',
      );
    }
  }

  const secrets = [
    {
      name: 'RATE_LIMIT_KEY_SECRET',
      value: environment.RATE_LIMIT_KEY_SECRET,
      placeholders: PRODUCTION_RATE_LIMIT_KEY_SECRET_PLACEHOLDERS,
    },
    {
      name: 'AUTH_CODE_PEPPER',
      value: environment.AUTH_CODE_PEPPER,
      placeholders: PRODUCTION_AUTH_CODE_PEPPER_PLACEHOLDERS,
    },
    {
      name: 'FOLLOWING_CURSOR_ENCRYPTION_KEY',
      value: environment.FOLLOWING_CURSOR_ENCRYPTION_KEY,
      placeholders: PRODUCTION_FOLLOWING_CURSOR_ENCRYPTION_KEY_PLACEHOLDERS,
    },
  ];
  for (const secret of secrets) {
    if (productionApi && secret.value === undefined) {
      addIssue(context, secret.name, `${secret.name} is required in production`);
    }
    if (
      secret.name === 'FOLLOWING_CURSOR_ENCRYPTION_KEY' &&
      secret.value !== undefined &&
      !/^[0-9a-f]{64}$/iu.test(secret.value)
    ) {
      addIssue(
        context,
        secret.name,
        'FOLLOWING_CURSOR_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters',
      );
    }
    if (
      productionApi &&
      secret.value !== undefined &&
      secret.placeholders.has(secret.value.toLowerCase())
    ) {
      addIssue(
        context,
        secret.name,
        `${secret.name} must not use a default placeholder in production`,
      );
    }
  }
};

const trustProxy = (
  value: string | undefined,
  nodeEnv: string | undefined,
  context: z.RefinementCtx,
) => {
  if (!value) return nodeEnv === 'development' ? 'loopback' : false;
  const normalized = value.trim();
  if (!normalized) return nodeEnv === 'development' ? 'loopback' : false;
  const lowerValue = normalized.toLowerCase();
  if (lowerValue === 'true') {
    context.addIssue({
      code: 'custom',
      path: ['TRUST_PROXY'],
      message:
        'TRUST_PROXY=true is unsafe with IP-based rate limiting. Use false, loopback, a numeric proxy hop count such as 1, or an explicit proxy list.',
    });
    return false;
  }
  if (lowerValue === 'false') return false;
  if (/^\d+$/u.test(normalized)) return Number(normalized);
  if (normalized.includes(',')) {
    const entries = normalized
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length > 0 ? entries : false;
  }
  return normalized;
};

const toConfig = (environment: EnvironmentFields, context: z.RefinementCtx) => {
  const parsedRole = runtimeRoleSchema.safeParse(environment.RUNTIME_ROLE ?? 'combined');
  const followingCursorKey =
    environment.FOLLOWING_CURSOR_ENCRYPTION_KEY ?? DEV_FOLLOWING_CURSOR_ENCRYPTION_KEY;
  const objectStorage = parseOptionalGroup(
    environment,
    OBJECT_STORAGE_REQUIRED,
    objectStorageConfiguredSchema,
    context,
    'Object storage configuration is incomplete.',
  );
  const mailer = parseOptionalGroup(
    environment,
    MAILER_REQUIRED,
    mailerConfiguredSchema,
    context,
    'Email delivery configuration is incomplete.',
  );

  return {
    port: environment.PORT,
    bcryptRounds: environment.BCRYPT_ROUNDS,
    databaseUrl: environment.DATABASE_URL,
    baseUrl: environment.BASE_URL,
    trustProxy: trustProxy(environment.TRUST_PROXY, environment.NODE_ENV, context),
    jsonBodyLimitBytes: environment.JSON_BODY_LIMIT_BYTES,
    profileMediaMaxUploadBytes: environment.PROFILE_MEDIA_MAX_UPLOAD_BYTES,
    isProduction: environment.NODE_ENV === 'production',
    runtimeRole: parsedRole.success ? parsedRole.data : 'combined',
    allowedOrigins: environment.CORS_ORIGINS,
    redisUrl: environment.REDIS_URL ?? null,
    objectStorage,
    videoUpload: {
      objectStorageBucket: environment.VIDEO_OBJECT_STORAGE_BUCKET,
      partSizeBytes: environment.VIDEO_UPLOAD_PART_SIZE_BYTES,
      maxPartCount: environment.VIDEO_UPLOAD_MAX_PARTS,
      maxUploadBytes: environment.VIDEO_UPLOAD_MAX_BYTES,
      maxTranscodeOutstandingJobs: environment.VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS,
      maxTranscodeOutstandingJobsPerUser: environment.VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER,
      userStorageQuotaBytes: environment.VIDEO_USER_STORAGE_QUOTA_BYTES,
      sessionTtlSeconds: environment.VIDEO_UPLOAD_SESSION_TTL_SECONDS,
    },
    videoTranscode: {
      maxConcurrentJobs: environment.VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS,
      threadsPerJob: environment.VIDEO_TRANSCODE_THREADS_PER_JOB,
      maxDurationSeconds: environment.VIDEO_TRANSCODE_MAX_DURATION_SECONDS,
      maxWidth: environment.VIDEO_TRANSCODE_MAX_WIDTH,
      maxHeight: environment.VIDEO_TRANSCODE_MAX_HEIGHT,
      maxPixels: environment.VIDEO_TRANSCODE_MAX_PIXELS,
      maxAspectRatio: environment.VIDEO_TRANSCODE_MAX_ASPECT_RATIO,
      maxFps: environment.VIDEO_TRANSCODE_MAX_FPS,
      ffprobeTimeoutMs: environment.VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS,
      ffmpegTimeoutMs: environment.VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS,
      maxArtifactBytes: environment.VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES,
    },
    authCodePepper: environment.AUTH_CODE_PEPPER ?? DEV_AUTH_CODE_PEPPER,
    followingCursorEncryptionKey: Buffer.from(followingCursorKey, 'hex'),
    rateLimitKeySecret: environment.RATE_LIMIT_KEY_SECRET ?? DEV_RATE_LIMIT_KEY_SECRET,
    sessionCleanupIntervalMs: environment.SESSION_CLEANUP_INTERVAL_MINUTES * MINUTE_MS,
    sessionCleanupInactiveRetentionMs:
      environment.SESSION_CLEANUP_INACTIVE_RETENTION_DAYS * DAYS_MS,
    mailer,
  };
};

export const environmentSchema = environmentSchemaFields
  .superRefine(validateCrossFieldRules)
  .transform(toConfig);

export type Config = z.output<typeof environmentSchema>;
export type RuntimeRole = Config['runtimeRole'];
export type ObjectStorageConfig = NonNullable<Config['objectStorage']>;
export type MailerConfig = NonNullable<Config['mailer']>;
export type VideoUploadConfig = Config['videoUpload'];
export type VideoTranscodeConfig = Config['videoTranscode'];

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigurationError';
  }
}

const formatConfigurationIssues = (issues: z.ZodError['issues']): string => {
  const messages = new Set<string>();
  for (const issue of issues) {
    const field = issue.path.map(String).join('.');
    const message =
      !field ||
      issue.message.includes(field) ||
      issue.message.startsWith('Object storage configuration is incomplete') ||
      issue.message.startsWith('Email delivery configuration is incomplete')
        ? issue.message
        : `${field}: ${issue.message}`;
    messages.add(message);
  }
  return [...messages].join('; ');
};

export const parseEnvironment = (environment: NodeJS.ProcessEnv): Config => {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ServerConfigurationError(formatConfigurationIssues(parsed.error.issues));
  }
  return parsed.data;
};
