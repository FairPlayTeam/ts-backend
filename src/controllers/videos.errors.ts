import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  VideoDeletionTemporarilyUnavailableError,
  VideoNotFoundError,
  VideoRatingTemporarilyUnavailableError,
  VideoSelfRatingForbiddenError,
} from '../services/videos.errors.js';

export function toVideosHttpError(err: unknown): Error {
  if (err instanceof VideoNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof VideoSelfRatingForbiddenError) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  if (
    err instanceof VideoRatingTemporarilyUnavailableError ||
    err instanceof VideoDeletionTemporarilyUnavailableError
  ) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
