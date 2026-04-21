import { describe, expect, it } from 'bun:test';
import {
  parseJsonBodyLimitBytes,
  parseMinioUrl,
  parseServerPort,
  parseTrustProxy,
  parseUrlEncodedBodyLimitBytes,
  resolveBaseUrl,
  ServerConfigurationError,
} from '../src/lib/serverConfig.js';

describe('parseTrustProxy', () => {
  it('defaults to false when unset', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
  });

  it('defaults to loopback in development when unset', () => {
    expect(parseTrustProxy(undefined, 'development')).toBe('loopback');
    expect(parseTrustProxy('', 'development')).toBe('loopback');
  });

  it('parses booleans and proxy counts', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
  });

  it('parses comma-separated trusted proxy lists', () => {
    expect(parseTrustProxy('loopback, linklocal')).toEqual([
      'loopback',
      'linklocal',
    ]);
  });
});

describe('parseServerPort', () => {
  it('parses valid port values', () => {
    expect(parseServerPort('3000')).toBe(3000);
  });

  it('rejects invalid ports', () => {
    expect(() => parseServerPort('0')).toThrow(ServerConfigurationError);
    expect(() => parseServerPort('abc')).toThrow(ServerConfigurationError);
  });
});

describe('request body size parsing', () => {
  it('uses safe defaults when unset', () => {
    expect(parseJsonBodyLimitBytes(undefined)).toBe(1024 * 1024);
    expect(parseUrlEncodedBodyLimitBytes(undefined)).toBe(256 * 1024);
  });

  it('accepts explicit byte limits and rejects invalid values', () => {
    expect(parseJsonBodyLimitBytes('2048')).toBe(2048);
    expect(parseUrlEncodedBodyLimitBytes('4096')).toBe(4096);
    expect(() => parseJsonBodyLimitBytes('0')).toThrow(
      ServerConfigurationError,
    );
    expect(() => parseUrlEncodedBodyLimitBytes('abc')).toThrow(
      ServerConfigurationError,
    );
  });
});

describe('resolveBaseUrl', () => {
  it('falls back to localhost with the configured port', () => {
    expect(resolveBaseUrl(undefined, 3000)).toBe('http://localhost:3000');
  });

  it('normalizes explicit URLs', () => {
    expect(resolveBaseUrl('https://api.example.com/', 3000)).toBe(
      'https://api.example.com',
    );
  });

  it('rejects invalid URLs', () => {
    expect(() => resolveBaseUrl('not-a-url', 3000)).toThrow(
      ServerConfigurationError,
    );
  });
});

describe('parseMinioUrl', () => {
  it('parses valid MinIO URLs', () => {
    expect(parseMinioUrl('https://minio:minio123@example.com:9443')).toEqual({
      endPoint: 'example.com',
      port: 9443,
      useSSL: true,
      accessKey: 'minio',
      secretKey: 'minio123',
    });
  });

  it('rejects missing values or credentials', () => {
    expect(() => parseMinioUrl(undefined)).toThrow(ServerConfigurationError);
    expect(() => parseMinioUrl('http://example.com:9000')).toThrow(
      ServerConfigurationError,
    );
  });
});
