import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  InvalidVideoUploadStateError,
  VideoNotFoundError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
} from '../services/videos.errors.js';

export function toVideosHttpError(err: unknown): Error {
  if (err instanceof VideoNotFoundError || err instanceof VideoUploadSessionNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof ActiveVideoUploadSessionExistsError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (
    err instanceof InvalidVideoUploadSessionStateError ||
    err instanceof InvalidVideoUploadStateError ||
    err instanceof VideoUploadSessionExpiredError
  ) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
