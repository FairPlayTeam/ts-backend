import { HttpError } from '../errors/http.js';
import { ObjectStorageUnavailableError } from '../lib/objectStorage.js';
import {
  AdminAccountAlreadyBannedError,
  AdminAccountNotFoundError,
  AdminBanReasonInvalidError,
  AdminRoleHierarchyError,
  AdminSelfBanError,
} from '../services/admin.errors.js';

export function toAdminHttpError(err: unknown): Error {
  if (err instanceof AdminBanReasonInvalidError) {
    return new HttpError(400, 'BadRequest', err.message, { cause: err });
  }

  if (err instanceof AdminRoleHierarchyError || err instanceof AdminSelfBanError) {
    return new HttpError(403, 'Forbidden', err.message, { cause: err });
  }

  if (err instanceof AdminAccountNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof AdminAccountAlreadyBannedError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof ObjectStorageUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
