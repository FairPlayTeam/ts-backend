import { HttpError } from '../../../errors/http.js';
import { ObjectStorageUnavailableError } from '../../../lib/objectStorage.js';
import { VIDEO_NOT_FOUND_MESSAGE, VideoNotFoundError } from '../../../services/videos.errors.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
  VideoStorageQuotaExceededError,
  VideoTranscodeAdmissionFullError,
  VideoUploadSessionExpiredError,
  VideoUploadSessionNotFoundError,
  VideoUploadSizeExceededError,
  VideoUploadSizeMismatchError,
} from '../errors.js';
import {
  UserMediaFileRequiredError,
  UserMediaFileTooLargeError,
  UserMediaInvalidImageError,
  UserMediaUnsupportedTypeError,
} from '../../../services/userMedia/userMedia.errors.js';

export const toVideoUploadsHttpError = (err: unknown): Error => {
  if (err instanceof VideoNotFoundError || err instanceof VideoUploadSessionNotFoundError) {
    return new HttpError(404, 'NotFound', VIDEO_NOT_FOUND_MESSAGE, { cause: err });
  }

  if (err instanceof VideoUploadSizeExceededError || err instanceof UserMediaFileTooLargeError) {
    return new HttpError(413, 'PayloadTooLarge', err.message, { cause: err });
  }

  if (err instanceof VideoTranscodeAdmissionFullError) {
    return new HttpError(429, 'TooManyRequests', err.message, { cause: err });
  }

  if (
    err instanceof UserMediaFileRequiredError ||
    err instanceof UserMediaUnsupportedTypeError ||
    err instanceof UserMediaInvalidImageError
  ) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (
    err instanceof ActiveVideoUploadSessionExistsError ||
    err instanceof InvalidVideoUploadSessionStateError ||
    err instanceof VideoStorageQuotaExceededError ||
    err instanceof VideoUploadSessionExpiredError ||
    err instanceof VideoUploadSizeMismatchError
  ) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
};
