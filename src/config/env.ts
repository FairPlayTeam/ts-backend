import {
  parseBcryptRounds,
  parseAllowedOrigins,
  parseMailerConfig,
  parseIsProduction,
  parseJsonBodyLimitBytes,
  parseRequiredUrl,
  parseServerPort,
  parseTrustProxy,
  readRequiredEnv,
} from './env.parsers.js';

const config = {
  port: parseServerPort(process.env.PORT),
  bcryptRounds: parseBcryptRounds(process.env.BCRYPT_ROUNDS),
  databaseUrl: readRequiredEnv(process.env.DATABASE_URL, 'DATABASE_URL'),
  baseUrl: parseRequiredUrl(process.env.BASE_URL, 'BASE_URL'),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV),
  jsonBodyLimitBytes: parseJsonBodyLimitBytes(process.env.JSON_BODY_LIMIT_BYTES),
  isProduction: parseIsProduction(process.env.NODE_ENV),
  allowedOrigins: parseAllowedOrigins(process.env.CORS_ORIGINS),
  mailer: parseMailerConfig({
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    smtpFrom: process.env.SMTP_FROM,
    frontendUrl: process.env.FRONTEND_URL,
  }),
};

export type Config = typeof config;

export default config;
