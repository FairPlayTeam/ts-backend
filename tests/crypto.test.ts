import { describe, expect, test } from 'bun:test';
import { generateToken, hashToken } from '../src/lib/crypto.js';

describe('crypto utils', () => {
  test('hashToken returns sha256 hash', () => {
    const token = 'hello world';

    const hash = hashToken(token);

    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  test('hashToken is deterministic', () => {
    const token = 'abc123';

    expect(hashToken(token)).toBe(hashToken(token));
  });

  test('generateToken returns 64-char hex string', () => {
    const token = generateToken();

    expect(token).toHaveLength(64);

    expect(token).toMatch(/^[a-f0-9]+$/);
  });

  test('generateToken generates different values', () => {
    const a = generateToken();
    const b = generateToken();

    expect(a).not.toBe(b);
  });
});
