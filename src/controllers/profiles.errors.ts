import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import { PublicProfileNotFoundError, SelfFollowError } from '../services/profiles.errors.js';

export function toProfilesHttpError(err: unknown): Error {
  if (err instanceof SelfFollowError) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof PublicProfileNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
