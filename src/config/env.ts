import {
  parseBcryptRounds,
  parseAllowedOrigins,
  parseMailerConfig,
  parseIsProduction,
  parseJsonBodyLimitBytes,
  parseOptionalUrl,
  parseRequiredUrl,
  parseServerPort,
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
  frontendUrl: process.env.FRONTEND_URL,
});

const config = {
  port: parseServerPort(process.env.PORT),
  bcryptRounds: parseBcryptRounds(process.env.BCRYPT_ROUNDS),
  databaseUrl: readRequiredEnv(process.env.DATABASE_URL, 'DATABASE_URL'),
  baseUrl: parseRequiredUrl(process.env.BASE_URL, 'BASE_URL'),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV),
  jsonBodyLimitBytes: parseJsonBodyLimitBytes(process.env.JSON_BODY_LIMIT_BYTES),
  isProduction,
  allowedOrigins: parseAllowedOrigins(process.env.CORS_ORIGINS),
  redisUrl: parseOptionalUrl(process.env.REDIS_URL, 'REDIS_URL'),
  mailer,
};

if (isProduction && !mailer) {
  throw new ServerConfigurationError(
    'Email delivery must be configured in production. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, and FRONTEND_URL.',
  );
}

if (isProduction && !config.redisUrl) {
  throw new ServerConfigurationError(
    'REDIS_URL is required in production for distributed rate limiting.',
  );
}

export type Config = typeof config;

export default config;
