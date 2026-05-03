import { describe, expect, test } from 'bun:test';
import { registerSchema } from '../src/controllers/auth.schemas.js';

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
