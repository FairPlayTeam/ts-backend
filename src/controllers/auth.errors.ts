import { HttpError } from '../errors/http.js';
import { UserAlreadyExistsError } from '../services/auth.errors.js';

export function toAuthHttpError(err: unknown): Error {
  if (err instanceof UserAlreadyExistsError) {
    return new HttpError(409, 'Conflict', 'User already exists', { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
