import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  AccountBannedError,
  AuthenticatedUserNotFoundError,
  EmailNotVerifiedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  PasswordResetPasswordReuseError,
  PasswordResetStateChangedError,
  ProfileUpdateEmptyError,
  UserAlreadyExistsError,
} from '../services/auth.errors.js';
import {
  UserMediaFileRequiredError,
  UserMediaFileTooLargeError,
  UserMediaInvalidImageError,
  UserMediaUnsupportedTypeError,
} from '../services/userMedia/userMedia.errors.js';

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

  if (err instanceof PasswordResetStateChangedError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ProfileUpdateEmptyError) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof AuthenticatedUserNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof AccountBannedError || err instanceof EmailNotVerifiedError) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  if (err instanceof UserMediaFileTooLargeError) {
    return new HttpError(413, 'PayloadTooLarge', err.message, { cause: err });
  }

  if (
    err instanceof UserMediaFileRequiredError ||
    err instanceof UserMediaUnsupportedTypeError ||
    err instanceof UserMediaInvalidImageError
  ) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
