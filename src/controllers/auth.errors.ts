import { HttpError } from '../errors/http.js';
import {
  AccountBannedError,
  EmailNotVerifiedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  UserAlreadyExistsError,
} from '../services/auth.errors.js';

export function toAuthHttpError(err: unknown): Error {
  if (err instanceof UserAlreadyExistsError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof InvalidCredentialsError) {
    return new HttpError(401, 'Unauthorized', err.message, { cause: err });
  }

  if (err instanceof InvalidEmailVerificationTokenError) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (
    err instanceof InvalidPasswordResetTokenError ||
    err instanceof PasswordResetPasswordReuseError
  ) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof AccountBannedError || err instanceof EmailNotVerifiedError) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
