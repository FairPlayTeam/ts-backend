import { HttpError } from '../../../errors/http.js';
import { VideoNotFoundError } from '../../../services/videos.errors.js';
import {
  CommentNotFoundError,
  CommentsDisabledError,
  CommentsTemporarilyUnavailableError,
} from '../errors.js';

export const toCommentsHttpError = (err: unknown): Error => {
  if (err instanceof CommentNotFoundError || err instanceof VideoNotFoundError) {
    return new HttpError(404, 'NotFound', err.message, { cause: err });
  }

  if (err instanceof CommentsDisabledError) {
    return new HttpError(409, 'Conflict', err.message, { cause: err });
  }

  if (err instanceof CommentsTemporarilyUnavailableError) {
    return new HttpError(503, 'ServiceUnavailable', err.message, { cause: err });
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
};
