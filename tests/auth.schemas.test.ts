import { describe, expect, test } from 'bun:test';
import { registerSchema, resendVerificationSchema } from '../src/controllers/auth.schemas.js';

const validRegisterBody = {
  email: 'user@example.com',
  username: 'fairplay_user',
  password: 'Password1!',
};

describe('registerSchema', () => {
  test('accepts a valid register payload', () => {
    const result = registerSchema.safeParse({ body: validRegisterBody });

    expect(result.success).toBe(true);
  });

  test('rejects unexpected body properties', () => {
    const result = registerSchema.safeParse({
      body: {
        ...validRegisterBody,
        role: 'admin',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects weak passwords', () => {
    const result = registerSchema.safeParse({
      body: {
        ...validRegisterBody,
        password: 'password',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('resendVerificationSchema', () => {
  test('accepts a valid resend verification payload', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'user@example.com',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects invalid resend verification emails', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'not-an-email',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected resend verification properties', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'user@example.com',
        token: 'unexpected',
      },
    });

    expect(result.success).toBe(false);
  });
});
