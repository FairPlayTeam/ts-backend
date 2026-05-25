import { describe, expect, test } from 'bun:test';
import { toAuthHttpError } from '../src/controllers/auth.errors.js';
import { HttpError } from '../src/errors/http.js';
import {
  AccountBannedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';

describe('auth error mapping', () => {
  test('maps duplicate users to an HTTP conflict', () => {
    const error = toAuthHttpError(new UserAlreadyExistsError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(409);
    expect((error as HttpError).code).toBe('Conflict');
  });

  test('maps invalid credentials to an HTTP unauthorized error', () => {
    const error = toAuthHttpError(new InvalidCredentialsError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(401);
    expect((error as HttpError).code).toBe('Unauthorized');
  });

  test('maps account state login failures to an HTTP forbidden error', () => {
    const error = toAuthHttpError(new AccountBannedError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(403);
    expect((error as HttpError).code).toBe('Forbidden');
  });

  test('maps invalid email verification tokens to an HTTP bad request', () => {
    const error = toAuthHttpError(new InvalidEmailVerificationTokenError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('maps invalid password reset tokens to an HTTP bad request', () => {
    const error = toAuthHttpError(new InvalidPasswordResetTokenError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('maps password reset password reuse to an HTTP bad request', () => {
    const error = toAuthHttpError(new PasswordResetPasswordReuseError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('passes through unknown application errors for the global handler', () => {
    const originalError = new Error('Unexpected application error');

    expect(toAuthHttpError(originalError)).toBe(originalError);
  });
});
