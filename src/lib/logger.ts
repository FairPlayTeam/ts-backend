import pino, { type LoggerOptions } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL?.trim() || (isTest ? 'silent' : isProduction ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[Redacted]',
  },
};

if (!isProduction) {
  options.base = null;
}

export const logger = pino(options);
