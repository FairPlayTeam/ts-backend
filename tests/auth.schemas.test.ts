import { describe, expect, test } from 'bun:test';
import {
  loginSchema,
  logoutSessionSchema,
  registerSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from '../src/controllers/auth.schemas.js';

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

  test('normalizes register email and username casing', () => {
    const result = registerSchema.safeParse({
      body: {
        email: ' USER@Example.COM ',
        username: ' FairPlay_User ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toEqual({
        email: 'user@example.com',
        username: 'fairplay_user',
        password: 'Password1!',
      });
    }
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

describe('loginSchema', () => {
  test('accepts a valid login payload and normalizes the identifier', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: ' USER@Example.COM ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.emailOrUsername).toBe('user@example.com');
    }
  });

  test('rejects empty login identifiers', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: ' ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected login properties', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: 'user@example.com',
        password: 'Password1!',
        rememberMe: true,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('verifyEmailSchema', () => {
  test('accepts a valid verification token and normalizes it', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        token: 'A'.repeat(64),
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.token).toBe('a'.repeat(64));
    }
  });

  test('rejects malformed verification tokens', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        token: 'not-a-token',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected verification properties', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        token: 'a'.repeat(64),
        email: 'user@example.com',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('logoutSessionSchema', () => {
  test('accepts a valid session id param', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects malformed session id params', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: 'not-a-session-id',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected session params', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        userId: '123e4567-e89b-12d3-a456-426614174001',
      },
    });

    expect(result.success).toBe(false);
  });
});
