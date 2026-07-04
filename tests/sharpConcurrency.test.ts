import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SHARP_CONCURRENCY,
  parseOptionalSharpConcurrency,
  parseSharpConcurrency,
} from '../src/lib/sharpConcurrency.js';

describe('sharp concurrency config', () => {
  test('uses the default concurrency when the env value is missing or blank', () => {
    expect(parseSharpConcurrency(undefined)).toBe(DEFAULT_SHARP_CONCURRENCY);
    expect(parseSharpConcurrency('   ')).toBe(DEFAULT_SHARP_CONCURRENCY);
  });

  test('accepts positive integer concurrency values', () => {
    expect(parseSharpConcurrency('2')).toBe(2);
    expect(parseOptionalSharpConcurrency('2')).toBe(2);
  });

  test('keeps the optional runtime config unset when the env value is missing or blank', () => {
    expect(parseOptionalSharpConcurrency(undefined)).toBeUndefined();
    expect(parseOptionalSharpConcurrency('   ')).toBeUndefined();
  });

  test('rejects invalid concurrency values', () => {
    expect(() => parseSharpConcurrency('0')).toThrow('SHARP_CONCURRENCY');
    expect(() => parseSharpConcurrency('1.5')).toThrow('SHARP_CONCURRENCY');
    expect(() => parseSharpConcurrency('not-a-number')).toThrow('SHARP_CONCURRENCY');
  });
});
