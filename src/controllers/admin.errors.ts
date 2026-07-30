import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  AdminAccountAlreadyBannedError,
  AdminAccountNotBannedError,
  AdminAccountNotFoundError,
  AdminBanReasonInvalidError,
  AdminRoleAlreadyAssignedError,
  AdminRoleAssignmentError,
  AdminRoleHierarchyError,
  AdminSelfBanError,
  AdminSelfUnbanError,
  AdminVideoRejectionReasonInvalidError,
} from '../services/admin.errors.js';
import { VideoNotFoundError } from '../services/videos.errors.js';

export function toAdminHttpError(err: unknown): Error {
  if (
    err instanceof AdminBanReasonInvalidError ||
    err instanceof AdminVideoRejectionReasonInvalidError
  ) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (
    err instanceof AdminRoleAssignmentError ||
    err instanceof AdminRoleHierarchyError ||
    err instanceof AdminSelfBanError ||
    err instanceof AdminSelfUnbanError
  ) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  if (err instanceof AdminAccountNotFoundError || err instanceof VideoNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (
    err instanceof AdminAccountAlreadyBannedError ||
    err instanceof AdminAccountNotBannedError ||
    err instanceof AdminRoleAlreadyAssignedError
  ) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
