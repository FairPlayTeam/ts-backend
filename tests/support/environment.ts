export const validDevelopmentEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/fairplay?schema=public',
  BASE_URL: 'http://localhost:3000',
});

export const validProductionApiEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  RUNTIME_ROLE: 'api',
  DATABASE_URL: 'postgresql://user:password@db.example.com:5432/fairplay?schema=public',
  BASE_URL: 'https://api.example.com',
  REDIS_URL: 'rediss://redis.example.com:6379',
  RATE_LIMIT_KEY_SECRET: 'production-rate-limit-secret-not-a-placeholder',
  AUTH_CODE_PEPPER: 'production-auth-code-pepper-not-a-placeholder',
  FOLLOWING_CURSOR_ENCRYPTION_KEY: 'ab'.repeat(32),
  OBJECT_STORAGE_ENDPOINT: 'https://s3.example.com',
  OBJECT_STORAGE_ACCESS_KEY: 'production-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'production-object-storage-secret',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_TLS_MODE: 'starttls',
  SMTP_USER: 'mailer@example.com',
  SMTP_PASS: 'production-mailer-secret',
  SMTP_FROM: 'noreply@example.com',
  VIDEO_TRANSCODE_MAX_CONCURRENT_JOBS: '0',
});
