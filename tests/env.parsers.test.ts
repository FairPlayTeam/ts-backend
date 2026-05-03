import { describe, expect, test } from 'bun:test';
import {
  ServerConfigurationError,
  parseAllowedOrigins,
  parseIsProduction,
  parseJsonBodyLimitBytes,
  parseMailerConfig,
  parseRequiredUrl,
  parseTrustProxy,
  readRequiredEnv,
} from '../src/config/env.parsers.js';

describe('env parsers', () => {
  test('rejects missing required values', () => {
    expect(() => readRequiredEnv('', 'DATABASE_URL')).toThrow(ServerConfigurationError);
  });

  test('normalizes required URLs', () => {
    expect(parseRequiredUrl('http://localhost:3000', 'BASE_URL')).toBe('http://localhost:3000/');
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

  test('parses runtime mode', () => {
    expect(parseIsProduction('production')).toBe(true);
    expect(parseIsProduction('development')).toBe(false);
  });

  test('parses and normalizes allowed CORS origins', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('http://localhost:5173, https://example.com/path')).toEqual([
      'http://localhost:5173',
      'https://example.com',
    ]);
    expect(() => parseAllowedOrigins('not-a-url')).toThrow(ServerConfigurationError);
  });

  test('parses optional mailer configuration', () => {
    expect(
      parseMailerConfig({
        smtpHost: undefined,
        smtpPort: undefined,
        smtpUser: undefined,
        smtpPass: undefined,
        smtpFrom: undefined,
        frontendUrl: undefined,
      }),
    ).toBeNull();

    expect(() =>
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: undefined,
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        frontendUrl: 'http://localhost:5173',
      }),
    ).toThrow(ServerConfigurationError);

    expect(
      parseMailerConfig({
        smtpHost: 'smtp.example.com',
        smtpPort: '587',
        smtpUser: 'user@example.com',
        smtpPass: 'secret',
        smtpFrom: 'no-reply@example.com',
        frontendUrl: 'http://localhost:5173',
      }),
    ).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUser: 'user@example.com',
      smtpPass: 'secret',
      smtpFrom: 'no-reply@example.com',
      frontendUrl: 'http://localhost:5173/',
    });
  });
});
