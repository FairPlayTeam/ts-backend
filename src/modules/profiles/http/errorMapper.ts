import { HttpError } from '../../../errors/http.js';
import { ObjectStorageUnavailableError } from '../../../lib/objectStorage.js';
import {
  InvalidFollowingProfilesCursorError,
  PublicProfileMediaNotFoundError,
  PublicProfileNotFoundError,
  SelfFollowError,
} from '../errors.js';

export function toProfilesHttpError(err: unknown): Error {
  if (err instanceof SelfFollowError || err instanceof InvalidFollowingProfilesCursorError) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof PublicProfileNotFoundError || err instanceof PublicProfileMediaNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
