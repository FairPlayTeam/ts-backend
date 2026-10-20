import { describe, expect, test } from 'bun:test';
import { parseEnvironment, ServerConfigurationError } from '../src/config/env.schema.js';
import {
  validDevelopmentEnvironment,
  validProductionApiEnvironment,
} from './support/environment.js';

describe('environment configuration', () => {
  test('keeps defaults exact and ignores foreign process variables', () => {
    const environment = validDevelopmentEnvironment();
    const config = parseEnvironment({
      ...environment,
      SHARP_CONCURRENCY: '1',
      LOG_LEVEL: 'debug',
      npm_package_version: '2.0.0',
      EXTERNAL_VARIABLE: 'ignored',
    });

    expect(config).toEqual({
      port: 3000,
      bcryptRounds: 12,
      databaseUrl: 'postgresql://user:password@localhost:5432/fairplay?schema=public',
      baseUrl: 'http://localhost:3000/',
      trustProxy: 'loopback',
      jsonBodyLimitBytes: 1048576,
      profileMediaMaxUploadBytes: 3145728,
      isProduction: false,
      runtimeRole: 'combined',
      allowedOrigins: [],
      redisUrl: null,
      objectStorage: null,
      videoUpload: {
        objectStorageBucket: 'videos',
        partSizeBytes: 67108864,
        maxPartCount: 10000,
        maxUploadBytes: 3221225472,
        maxTranscodeOutstandingJobs: 10,
        maxTranscodeOutstandingJobsPerUser: 2,
        userStorageQuotaBytes: 107374182400,
        sessionTtlSeconds: 86400,
        idleTtlSeconds: 900,
        maxReservationsPerHour: 2,
      },
      videoTranscode: {
        maxConcurrentJobs: 0,
        threadsPerJob: 2,
        maxDurationSeconds: 1800,
        maxWidth: 3840,
        maxHeight: 3840,
        maxPixels: 8294400,
        maxAspectRatio: 4,
        maxFps: 30,
        ffprobeTimeoutMs: 30000,
        ffmpegTimeoutMs: 7200000,
        maxArtifactBytes: 4294967296,
      },
      authCodePepper: 'development-auth-code-pepper-change-me',
      followingCursorEncryptionKey: Buffer.from('development-following-cursor-key'),
      rateLimitKeySecret: 'development-rate-limit-key-secret-change-me',
      sessionCleanupIntervalMs: 3600000,
      sessionCleanupInactiveRetentionMs: 2592000000,
      mailer: null,
    });
    expect(parseEnvironment(environment)).toEqual(config);
  });

  test('environment factories return fresh objects', () => {
    validDevelopmentEnvironment().PORT = '1';
    validProductionApiEnvironment().PORT = '1';
    expect(validDevelopmentEnvironment().PORT).toBeUndefined();
    expect(validProductionApiEnvironment().PORT).toBeUndefined();
  });

  test('normalizes HTTP URLs and rejects unsafe schemes', () => {
    const validUrls: Array<readonly [string, string]> = [
      ['http://localhost:3000', 'http://localhost:3000/'],
      ['https://api.example.com/path', 'https://api.example.com/path'],
    ];
    for (const [baseUrl, expected] of validUrls) {
      expect(
        parseEnvironment({ ...validDevelopmentEnvironment(), BASE_URL: baseUrl }).baseUrl,
      ).toBe(expected);
    }
    for (const baseUrl of ['ftp://api.example.com', 'not a URL']) {
      expect(() =>
        parseEnvironment({ ...validDevelopmentEnvironment(), BASE_URL: baseUrl }),
      ).toThrow('BASE_URL');
    }
  });

  test('normalizes CORS origins and enforces the wildcard rule', () => {
    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        CORS_ORIGINS:
          'https://app.example.com/path, http://localhost:3000/,https://app.example.com',
      }).allowedOrigins,
    ).toEqual(['https://app.example.com', 'http://localhost:3000']);
    expect(
      parseEnvironment({ ...validDevelopmentEnvironment(), CORS_ORIGINS: '*' }).allowedOrigins,
    ).toBe('*');
    expect(() =>
      parseEnvironment({ ...validDevelopmentEnvironment(), CORS_ORIGINS: '*,https://app.test' }),
    ).toThrow('CORS_ORIGINS');
    expect(() =>
      parseEnvironment({ ...validDevelopmentEnvironment(), CORS_ORIGINS: 'ftp://app.example.com' }),
    ).toThrow('CORS_ORIGINS');
    expect(() =>
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        REDIS_URL: 'https://redis.example.com',
      }),
    ).toThrow('REDIS_URL');
  });

  test('retains scalar and active-group rejection cases through parseEnvironment', () => {
    const storage = {
      OBJECT_STORAGE_ENDPOINT: 'https://s3.example.com',
      OBJECT_STORAGE_ACCESS_KEY: 'access-key',
      OBJECT_STORAGE_SECRET_KEY: 'storage-secret',
    };
    const mailer = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_TLS_MODE: 'starttls',
      SMTP_USER: 'mailer@example.com',
      SMTP_PASS: 'mailer-secret',
      SMTP_FROM: 'noreply@example.com',
    };
    const invalidCases: Array<readonly [string, NodeJS.ProcessEnv, string]> = [
      ['DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL'],
      ['BASE_URL', { BASE_URL: undefined }, 'BASE_URL'],
      ['RUNTIME_ROLE', { RUNTIME_ROLE: 'unknown' }, 'RUNTIME_ROLE'],
      [
        'VIDEO_OBJECT_STORAGE_BUCKET',
        { VIDEO_OBJECT_STORAGE_BUCKET: 'bad_bucket' },
        'VIDEO_OBJECT_STORAGE_BUCKET',
      ],
      [
        'OBJECT_STORAGE_REGION',
        { ...storage, OBJECT_STORAGE_REGION: 'bad region' },
        'OBJECT_STORAGE_REGION',
      ],
      [
        'OBJECT_STORAGE_PUBLIC_URL',
        { ...storage, OBJECT_STORAGE_PUBLIC_URL: 'ftp://cdn.example.com/path' },
        'OBJECT_STORAGE_PUBLIC_URL',
      ],
      ['SMTP_TLS_MODE', { ...mailer, SMTP_TLS_MODE: 'unknown' }, 'SMTP_TLS_MODE'],
    ];

    for (const [label, overrides, errorName] of invalidCases) {
      expect(
        () => parseEnvironment({ ...validDevelopmentEnvironment(), ...overrides }),
        label,
      ).toThrow(errorName);
    }

    const proxyCases: Array<readonly [string, false | number | string[]]> = [
      ['false', false],
      ['2', 2],
      ['1, 10.0.0.0/8', ['1', '10.0.0.0/8']],
    ];
    for (const [value, expected] of proxyCases) {
      expect(
        parseEnvironment({ ...validDevelopmentEnvironment(), TRUST_PROXY: value }).trustProxy,
      ).toEqual(expected);
    }
    expect(() =>
      parseEnvironment({ ...validDevelopmentEnvironment(), TRUST_PROXY: 'true' }),
    ).toThrow('TRUST_PROXY');
  });
});

describe('numeric environment variable matrix', () => {
  const base: NodeJS.ProcessEnv = {
    ...validDevelopmentEnvironment(),
    OBJECT_STORAGE_ENDPOINT: 'https://s3.example.com',
    OBJECT_STORAGE_ACCESS_KEY: 'access-key',
    OBJECT_STORAGE_SECRET_KEY: 'secret-key',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_TLS_MODE: 'starttls',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASS: 'smtp-secret',
    SMTP_FROM: 'noreply@example.com',
  };
  const uploadAtCapacity: NodeJS.ProcessEnv = {
    VIDEO_UPLOAD_PART_SIZE_BYTES: '99999999',
    VIDEO_UPLOAD_MAX_PARTS: '10000',
    VIDEO_UPLOAD_MAX_BYTES: '1',
    VIDEO_USER_STORAGE_QUOTA_BYTES: '9007199254740991',
  };
  type NumericMode = 'number' | 'body' | 'required-number' | 'nonnegative';
  type NumericCase = readonly [string, string, string, NumericMode?];
  const rows: NumericCase[] = [
    ['PORT', '1', '65535', 'number'],
    ['BCRYPT_ROUNDS', '4', '31', 'number'],
    ['JSON_BODY_LIMIT_BYTES', '1', '9007199254740992', 'body'],
    ['PROFILE_MEDIA_MAX_UPLOAD_BYTES', '1', '9007199254740992', 'body'],
    ['SMTP_PORT', '1', '65535', 'required-number'],
    ['SMTP_TIMEOUT_MS', '1', '120000'],
    ['OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS', '1', '604800'],
    ['OBJECT_STORAGE_TIMEOUT_MS', '1', '120000'],
    ['SESSION_CLEANUP_INTERVAL_MINUTES', '1', '9007199254740991'],
    ['SESSION_CLEANUP_INACTIVE_RETENTION_DAYS', '1', '9007199254740991'],
    ['VIDEO_UPLOAD_PART_SIZE_BYTES', '5242880', '99999999'],
    ['VIDEO_UPLOAD_MAX_PARTS', '1', '10000'],
    ['VIDEO_UPLOAD_MAX_BYTES', '1', '999999990000'],
    ['VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_OUTSTANDING_JOBS_PER_USER', '1', '9007199254740991'],
    ['VIDEO_USER_STORAGE_QUOTA_BYTES', '1', '9007199254740991'],
    ['VIDEO_UPLOAD_SESSION_TTL_SECONDS', '60', '9007199254740991'],
    ['VIDEO_UPLOAD_IDLE_TTL_SECONDS', '60', '9007199254740991'],
    ['VIDEO_UPLOAD_MAX_RESERVATIONS_PER_HOUR', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS', '0', '9007199254740991', 'nonnegative'],
    ['VIDEO_TRANSCODE_THREADS_PER_JOB', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_DURATION_SECONDS', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_WIDTH', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_HEIGHT', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_PIXELS', '1', '2147483647'],
    ['VIDEO_TRANSCODE_MAX_ASPECT_RATIO', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_MAX_FPS', '1', '9007199254740991'],
    ['VIDEO_TRANSCODE_FFPROBE_TIMEOUT_MS', '1', '604800000'],
    ['VIDEO_TRANSCODE_FFMPEG_TIMEOUT_MS', '1', '604800000'],
    ['VIDEO_TRANSCODE_MAX_ARTIFACT_BYTES', '1', '9007199254740991'],
  ];
  const overrides: Record<string, NodeJS.ProcessEnv> = {
    VIDEO_UPLOAD_SESSION_TTL_SECONDS: { VIDEO_UPLOAD_IDLE_TTL_SECONDS: '60' },
    VIDEO_UPLOAD_IDLE_TTL_SECONDS: { VIDEO_UPLOAD_SESSION_TTL_SECONDS: '9007199254740991' },
    VIDEO_UPLOAD_MAX_PARTS: { VIDEO_UPLOAD_MAX_BYTES: '1', VIDEO_USER_STORAGE_QUOTA_BYTES: '1' },
    VIDEO_UPLOAD_MAX_BYTES: uploadAtCapacity,
    VIDEO_USER_STORAGE_QUOTA_BYTES: { VIDEO_UPLOAD_MAX_BYTES: '1' },
  };

  const accepts = (name: string, value: string | undefined, extra: NodeJS.ProcessEnv = {}) => {
    const environment = { ...base, ...extra };
    delete environment[name];
    if (value !== undefined) environment[name] = value;
    try {
      parseEnvironment(environment);
      return true;
    } catch {
      return false;
    }
  };

  test('covers absent, blank, limits, zero, lexical forms, and overflow', () => {
    for (const [name, minimum, maximum, mode = 'strict'] of rows) {
      const extra = overrides[name] ?? {};
      const numberMode = mode === 'number' || mode === 'required-number';
      expect(accepts(name, undefined, extra), `${name} absent`).toBe(mode !== 'required-number');
      expect(accepts(name, '', extra), `${name} blank`).toBe(!numberMode);
      expect(accepts(name, minimum, extra), `${name} minimum`).toBe(true);
      expect(accepts(name, maximum, extra), `${name} maximum`).toBe(true);
      expect(accepts(name, '0', extra), `${name} zero`).toBe(mode === 'nonnegative');
      for (const invalid of [
        '-1',
        '1.5',
        '9007199254740992',
        '1e309',
        String(Number(maximum) + 1),
      ]) {
        expect(accepts(name, invalid, extra), `${name} rejects ${invalid}`).toBe(
          mode === 'body' && invalid === '9007199254740992',
        );
      }
      const numberForms =
        name === 'BCRYPT_ROUNDS' ? ['4e0', '4.0', '04', '+4'] : ['1e3', '1.0', '01', '+1'];
      for (const form of numberForms) {
        expect(accepts(name, form, extra), `${name} lexical form ${form}`).toBe(
          numberMode || mode === 'body',
        );
      }
    }
  });
});

describe('optional mailer and object storage', () => {
  test('leaves groups disabled when primary fields are absent, regardless of optional fields', () => {
    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        OBJECT_STORAGE_BUCKET: 'invalid_bucket',
        OBJECT_STORAGE_REGION: 'bad region',
        OBJECT_STORAGE_PUBLIC_URL: 'ftp://invalid.example.com/path',
        OBJECT_STORAGE_TIMEOUT_MS: '0',
        SMTP_TIMEOUT_MS: 'invalid',
      }),
    ).toMatchObject({ objectStorage: null, mailer: null });
  });

  test('lists each missing object storage requirement and applies origin and bucket rules', () => {
    const complete = {
      OBJECT_STORAGE_ENDPOINT: 'https://storage.example.com',
      OBJECT_STORAGE_ACCESS_KEY: 'access',
      OBJECT_STORAGE_SECRET_KEY: 'secret',
    };
    for (const missing of Object.keys(complete)) {
      const environment: NodeJS.ProcessEnv = { ...validDevelopmentEnvironment(), ...complete };
      delete environment[missing];
      expect(() => parseEnvironment(environment)).toThrow(
        'Object storage configuration is incomplete',
      );
      expect(() => parseEnvironment(environment)).toThrow(missing);
    }

    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        ...complete,
        OBJECT_STORAGE_ENDPOINT: 'http://storage.example.com/',
      }).objectStorage,
    ).toMatchObject({
      endpoint: 'http://storage.example.com',
      publicUrl: 'http://storage.example.com',
      region: 'us-east-1',
      bucket: 'user-media',
      signedUrlTtlSeconds: 900,
      operationTimeoutMs: 5000,
    });

    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        ...complete,
        OBJECT_STORAGE_PUBLIC_URL: 'https://cdn.example.com/',
        OBJECT_STORAGE_REGION: 'eu-west-3',
        OBJECT_STORAGE_BUCKET: 'media-bucket',
        OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: '604800',
        OBJECT_STORAGE_TIMEOUT_MS: '120000',
      }).objectStorage,
    ).toEqual({
      endpoint: 'https://storage.example.com',
      publicUrl: 'https://cdn.example.com',
      region: 'eu-west-3',
      bucket: 'media-bucket',
      accessKey: 'access',
      secretKey: 'secret',
      signedUrlTtlSeconds: 604800,
      operationTimeoutMs: 120000,
    });

    for (const endpoint of [
      'ftp://storage.example.com',
      'https://storage.example.com/path',
      'https://storage.example.com?region=1',
      'https://storage.example.com#bucket',
    ]) {
      expect(() =>
        parseEnvironment({
          ...validDevelopmentEnvironment(),
          ...complete,
          OBJECT_STORAGE_ENDPOINT: endpoint,
        }),
      ).toThrow('OBJECT_STORAGE_ENDPOINT');
    }
    for (const bucket of ['ab', 'x'.repeat(64), 'a..b', '192.168.1.1', 'bad_bucket']) {
      expect(() =>
        parseEnvironment({
          ...validDevelopmentEnvironment(),
          ...complete,
          OBJECT_STORAGE_BUCKET: bucket,
        }),
      ).toThrow('OBJECT_STORAGE_BUCKET');
    }
  });

  test('lists mailer fields, normalizes TLS, and keeps none available outside production', () => {
    const complete = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_TLS_MODE: 'STARTTLS',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'secret',
      SMTP_FROM: 'noreply@example.com',
    };
    for (const missing of Object.keys(complete)) {
      const environment: NodeJS.ProcessEnv = { ...validDevelopmentEnvironment(), ...complete };
      delete environment[missing];
      expect(() => parseEnvironment(environment)).toThrow(
        'Email delivery configuration is incomplete',
      );
      expect(() => parseEnvironment(environment)).toThrow(missing);
    }
    expect(
      parseEnvironment({ ...validDevelopmentEnvironment(), ...complete }).mailer,
    ).toMatchObject({ smtpPort: 587, smtpTlsMode: 'starttls', operationTimeoutMs: 10000 });
    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        ...complete,
        SMTP_PORT: '65535',
        SMTP_TIMEOUT_MS: '120000',
      }).mailer,
    ).toMatchObject({ smtpPort: 65535, operationTimeoutMs: 120000 });
    expect(
      parseEnvironment({ ...validDevelopmentEnvironment(), ...complete, SMTP_TLS_MODE: 'NONE' })
        .mailer?.smtpTlsMode,
    ).toBe('none');
  });
});

describe('runtime roles, secrets, and cross-field limits', () => {
  test('validates development and production role combinations and worker limits', () => {
    const development = validDevelopmentEnvironment();
    expect(parseEnvironment(development).runtimeRole).toBe('combined');
    const productionApi = parseEnvironment(validProductionApiEnvironment());
    expect(productionApi.runtimeRole).toBe('api');
    expect(productionApi.followingCursorEncryptionKey).toHaveLength(32);
    expect(
      parseEnvironment({ ...development, RUNTIME_ROLE: 'api' }).videoTranscode.maxConcurrentJobs,
    ).toBe(0);
    expect(
      parseEnvironment({
        ...development,
        RUNTIME_ROLE: 'transcoder',
        VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: '1',
      }).runtimeRole,
    ).toBe('transcoder');

    for (const environment of [
      { ...validProductionApiEnvironment(), RUNTIME_ROLE: undefined },
      { ...validProductionApiEnvironment(), RUNTIME_ROLE: 'combined' },
      { ...validProductionApiEnvironment(), VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: '1' },
      {
        ...validDevelopmentEnvironment(),
        RUNTIME_ROLE: 'api',
        VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: '1',
      },
      { ...validDevelopmentEnvironment(), RUNTIME_ROLE: 'transcoder' },
    ]) {
      expect(() => parseEnvironment(environment)).toThrow(ServerConfigurationError);
    }

    const transcoder: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      RUNTIME_ROLE: 'transcoder',
      DATABASE_URL: 'postgresql://worker.example.com/app',
      BASE_URL: 'https://api.example.com',
      OBJECT_STORAGE_ENDPOINT: 'https://s3.example.com',
      OBJECT_STORAGE_ACCESS_KEY: 'worker-access-key',
      OBJECT_STORAGE_SECRET_KEY: 'worker-object-storage-secret',
      VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: '1',
      VIDEO_TRANSCODE_THREADS_PER_JOB: '2',
      RATE_LIMIT_KEY_SECRET: 'development-rate-limit-key-secret-change-me',
      AUTH_CODE_PEPPER: 'development-auth-code-pepper-change-me',
      FOLLOWING_CURSOR_ENCRYPTION_KEY:
        '646576656c6f706d656e742d666f6c6c6f77696e672d637572736f722d6b6579',
    };
    expect(parseEnvironment(transcoder)).toMatchObject({ redisUrl: null, mailer: null });
    const noWorkerStorage = { ...transcoder };
    delete noWorkerStorage.OBJECT_STORAGE_ENDPOINT;
    delete noWorkerStorage.OBJECT_STORAGE_ACCESS_KEY;
    delete noWorkerStorage.OBJECT_STORAGE_SECRET_KEY;
    expect(() => parseEnvironment(noWorkerStorage)).toThrow('Object storage must be configured');
    expect(() => parseEnvironment({ ...transcoder, VIDEO_TRANSCODE_THREADS_PER_JOB: '3' })).toThrow(
      'VIDEO_TRANSCODE_THREADS_PER_JOB',
    );
  });

  test('requires production API dependencies and rejects weak or placeholder secrets without echoing them', () => {
    for (const variable of [
      'REDIS_URL',
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_ACCESS_KEY',
      'OBJECT_STORAGE_SECRET_KEY',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_TLS_MODE',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
      'RATE_LIMIT_KEY_SECRET',
      'AUTH_CODE_PEPPER',
      'FOLLOWING_CURSOR_ENCRYPTION_KEY',
    ]) {
      const environment = validProductionApiEnvironment();
      delete environment[variable];
      expect(() => parseEnvironment(environment)).toThrow(variable);
    }
    expect(() =>
      parseEnvironment({ ...validProductionApiEnvironment(), SMTP_TLS_MODE: 'none' }),
    ).toThrow('SMTP_TLS_MODE=none');

    const invalidSecrets: Array<readonly [string, string]> = [
      ['RATE_LIMIT_KEY_SECRET', 'short'],
      ['RATE_LIMIT_KEY_SECRET', 'development-rate-limit-key-secret-change-me'],
      ['RATE_LIMIT_KEY_SECRET', 'change-me-with-at-least-32-characters'],
      ['AUTH_CODE_PEPPER', 'short'],
      ['AUTH_CODE_PEPPER', 'development-auth-code-pepper-change-me'],
      ['AUTH_CODE_PEPPER', 'change-me-auth-code-pepper-32-characters'],
      ['AUTH_CODE_PEPPER', 'local-compose-auth-code-pepper-4f9e1a7b2c8d0e6f'],
      [
        'FOLLOWING_CURSOR_ENCRYPTION_KEY',
        '646576656c6f706d656e742d666f6c6c6f77696e672d637572736f722d6b6579',
      ],
      ['FOLLOWING_CURSOR_ENCRYPTION_KEY', '0'.repeat(64)],
      [
        'FOLLOWING_CURSOR_ENCRYPTION_KEY',
        '78c1c8d89b9982db066232c742118a9dd8263a8f0671f840a88f45c595c45d8f',
      ],
      ['FOLLOWING_CURSOR_ENCRYPTION_KEY', 'ab'.repeat(31)],
      ['FOLLOWING_CURSOR_ENCRYPTION_KEY', `${'ab'.repeat(31)}ag`],
    ];
    for (const [variable, value] of invalidSecrets) {
      expect(() =>
        parseEnvironment({ ...validProductionApiEnvironment(), [variable]: value }),
      ).toThrow(variable);
    }

    const secret = 'secret-that-must-not-appear';
    let caught: unknown;
    try {
      parseEnvironment({ ...validProductionApiEnvironment(), AUTH_CODE_PEPPER: secret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerConfigurationError);
    if (caught instanceof Error) {
      expect(caught.message).toContain('AUTH_CODE_PEPPER');
      expect(caught.message).not.toContain(secret);
      expect(caught.message).not.toContain('ZodError');
    }
  });

  test('rejects idle windows too short for bounded progress checks, including 20 seconds', () => {
    for (const seconds of ['1', '20', '59']) {
      expect(() =>
        parseEnvironment({
          ...validDevelopmentEnvironment(),
          VIDEO_UPLOAD_IDLE_TTL_SECONDS: seconds,
        }),
      ).toThrow('VIDEO_UPLOAD_IDLE_TTL_SECONDS');
    }
    expect(
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        VIDEO_UPLOAD_IDLE_TTL_SECONDS: '60',
        VIDEO_UPLOAD_SESSION_TTL_SECONDS: '60',
      }).videoUpload.idleTtlSeconds,
    ).toBe(60);
    expect(() =>
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        VIDEO_UPLOAD_IDLE_TTL_SECONDS: '60',
        VIDEO_UPLOAD_SESSION_TTL_SECONDS: '59',
      }),
    ).toThrow('VIDEO_UPLOAD_IDLE_TTL_SECONDS');
  });

  test('rejects inconsistent multipart capacity and user quota', () => {
    expect(() =>
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        VIDEO_UPLOAD_IDLE_TTL_SECONDS: '901',
        VIDEO_UPLOAD_SESSION_TTL_SECONDS: '900',
      }),
    ).toThrow('VIDEO_UPLOAD_IDLE_TTL_SECONDS');
    expect(() =>
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        VIDEO_UPLOAD_PART_SIZE_BYTES: '5242880',
        VIDEO_UPLOAD_MAX_PARTS: '1',
        VIDEO_UPLOAD_MAX_BYTES: '5242881',
        VIDEO_USER_STORAGE_QUOTA_BYTES: '5242881',
      }),
    ).toThrow('VIDEO_UPLOAD_MAX_BYTES');
    expect(() =>
      parseEnvironment({
        ...validDevelopmentEnvironment(),
        VIDEO_UPLOAD_MAX_BYTES: '1024',
        VIDEO_USER_STORAGE_QUOTA_BYTES: '1023',
      }),
    ).toThrow('VIDEO_USER_STORAGE_QUOTA_BYTES');
  });
});

describe('environment bootstrap', () => {
  const boot = (environment: NodeJS.ProcessEnv) => {
    const childEnvironment: Record<string, string> = {};
    for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) childEnvironment[key] = value;
    }
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined) childEnvironment[key] = value;
    }
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', "await import('./src/config/env.ts')"],
      cwd: process.cwd(),
      env: childEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: child.exitCode, stderr: new TextDecoder().decode(child.stderr) };
  };

  test('imports env.ts with a valid environment and fails on a weak secret without leaking it', () => {
    expect(boot(validDevelopmentEnvironment()).exitCode).toBe(0);
    const secret = 'bootstrap-secret';
    const result = boot({
      ...validProductionApiEnvironment(),
      AUTH_CODE_PEPPER: secret,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('AUTH_CODE_PEPPER');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('ZodError');
  });
});
