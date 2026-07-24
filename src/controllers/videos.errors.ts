import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  InvalidVideoUploadStateError,
  VideoStorageQuotaExceededError,
  VideoNotFoundError,
  VideoUploadSizeExceededError,
  VideoUploadSizeMismatchError,
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

  if (err instanceof VideoUploadSizeExceededError) {
    return new HttpError(413, 'PayloadTooLarge', err.message, { cause: err });
  }

  if (
    err instanceof InvalidVideoUploadSessionStateError ||
    err instanceof InvalidVideoUploadStateError ||
    err instanceof VideoUploadSessionExpiredError ||
    err instanceof VideoStorageQuotaExceededError ||
    err instanceof VideoUploadSizeMismatchError
  ) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
