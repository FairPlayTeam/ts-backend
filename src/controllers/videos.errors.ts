import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  InvalidVideoUploadStateError,
  VideoCommentNotFoundError,
  VideoCommentsDisabledError,
  VideoCommentTemporarilyUnavailableError,
  VideoStorageQuotaExceededError,
  VideoNotFoundError,
  VideoRatingTemporarilyUnavailableError,
  VideoSelfRatingForbiddenError,
  VideoUploadSizeExceededError,
  VideoUploadSizeMismatchError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
} from '../services/videos.errors.js';
import {
  UserMediaFileRequiredError,
  UserMediaFileTooLargeError,
  UserMediaInvalidImageError,
  UserMediaUnsupportedTypeError,
} from '../services/userMedia/userMedia.errors.js';

export function toVideosHttpError(err: unknown): Error {
  if (err instanceof VideoNotFoundError || err instanceof VideoUploadSessionNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof VideoCommentNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof VideoCommentsDisabledError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof VideoSelfRatingForbiddenError) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  if (
    err instanceof VideoRatingTemporarilyUnavailableError ||
    err instanceof VideoCommentTemporarilyUnavailableError
  ) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  if (err instanceof ActiveVideoUploadSessionExistsError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof VideoUploadSizeExceededError) {
    return new HttpError(413, 'PayloadTooLarge', err.message, { cause: err });
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
