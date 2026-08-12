import { describe, expect, test } from 'bun:test';
import { toAuthHttpError } from '../src/controllers/auth.errors.js';
import { HttpError } from '../src/errors/http.js';
import { ObjectStorageUnavailableError } from '../src/lib/objectStorage.js';
import {
  AccountBannedError,
  AccountDeletionTemporarilyUnavailableError,
  AuthenticatedUserNotFoundError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  PasswordResetStateChangedError,
  ProfileUpdateEmptyError,
  UserAlreadyExistsError,
} from '../src/services/auth.errors.js';
import {
  UserMediaFileTooLargeError,
  UserMediaUnsupportedTypeError,
} from '../src/services/userMedia/userMedia.errors.js';

describe('auth error mapping', () => {
  test('maps exhausted account deletion contention to service unavailable', () => {
    const error = toAuthHttpError(new AccountDeletionTemporarilyUnavailableError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(503);
    expect((error as HttpError).code).toBe('ServiceUnavailable');
  });

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

  test('maps invalid email verification codes to an HTTP bad request', () => {
    const error = toAuthHttpError(new InvalidEmailVerificationTokenError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('maps invalid password reset codes to an HTTP bad request', () => {
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

  test('maps password reset state changes to an HTTP conflict', () => {
    const error = toAuthHttpError(new PasswordResetStateChangedError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(409);
    expect((error as HttpError).code).toBe('Conflict');
  });

  test('maps empty profile updates to bad request', () => {
    const error = toAuthHttpError(new ProfileUpdateEmptyError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('maps missing authenticated users to not found', () => {
    const error = toAuthHttpError(new AuthenticatedUserNotFoundError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(404);
    expect((error as HttpError).code).toBe('NotFound');
  });

  test('maps oversized user media files to payload too large', () => {
    const error = toAuthHttpError(new UserMediaFileTooLargeError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(413);
    expect((error as HttpError).code).toBe('PayloadTooLarge');
  });

  test('maps invalid user media files to bad request', () => {
    const error = toAuthHttpError(new UserMediaUnsupportedTypeError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(400);
    expect((error as HttpError).code).toBe('BadRequest');
  });

  test('maps unavailable object storage to service unavailable', () => {
    const error = toAuthHttpError(new ObjectStorageUnavailableError());

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(503);
    expect((error as HttpError).code).toBe('ServiceUnavailable');
  });

  test('passes through unknown application errors for the global handler', () => {
    const originalError = new Error('Unexpected application error');

    expect(toAuthHttpError(originalError)).toBe(originalError);
  });
});
