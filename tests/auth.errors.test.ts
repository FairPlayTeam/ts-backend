import { describe, expect, test } from 'bun:test';
import { toAuthHttpError } from '../src/controllers/auth.errors.js';
import { HttpError } from '../src/errors/http.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';

describe('auth error mapping', () => {
  test('maps duplicate users to an HTTP conflict', () => {
    const error = toAuthHttpError(new UserAlreadyExistsError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(409);
    expect((error as HttpError).code).toBe('Conflict');
  });

  test('passes through unknown application errors for the global handler', () => {
    const originalError = new Error('Unexpected application error');

    expect(toAuthHttpError(originalError)).toBe(originalError);
  });
});
