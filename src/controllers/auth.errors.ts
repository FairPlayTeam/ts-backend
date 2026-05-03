import { HttpError } from '../errors/http.js';
import {
  UserAlreadyExistsError,
  VerificationEmailUnavailableError,
} from '../services/auth.errors.js';

export function toAuthHttpError(err: unknown): Error {
  if (err instanceof UserAlreadyExistsError) {
    return new HttpError(409, 'Conflict', 'User already exists', err);
  }

  if (err instanceof VerificationEmailUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', 'Email delivery failed', err);
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
