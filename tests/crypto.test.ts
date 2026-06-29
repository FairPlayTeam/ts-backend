import { describe, expect, test } from 'bun:test';
import { generateSixDigitCode, generateToken, hashAuthCode, hashToken } from '../src/lib/crypto.js';

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

  test('hashAuthCode returns an HMAC using the configured pepper', () => {
    const secret = 'user-id:123456';
    const pepper = 'test-auth-code-pepper-123456789012';

    expect(hashAuthCode(secret, pepper)).toBe(
      '0d443effbecd5eea9ba9244c27c52ee9b5cad1b97ff3b8eed4ee50dc7da0d87c',
    );
    expect(hashAuthCode(secret, 'other-auth-code-pepper-123456789')).not.toBe(
      hashAuthCode(secret, pepper),
    );
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

  test('generateSixDigitCode returns a fixed-width numeric code', () => {
    const code = generateSixDigitCode();

    expect(code).toMatch(/^\d{6}$/);
  });
});
