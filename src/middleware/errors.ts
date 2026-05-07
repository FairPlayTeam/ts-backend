import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError, isHttpError, type ApiErrorResponse } from '../errors/http.js';
import { logger } from '../lib/logger.js';

type HttpStatusError = Error & {
  expose?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isHttpStatusError = (err: unknown): err is HttpStatusError =>
  err instanceof Error && isObject(err);

const getHttpStatus = (err: HttpStatusError): number | null => {
  const status = typeof err.status === 'number' ? err.status : err.statusCode;

  if (typeof status !== 'number' || !Number.isInteger(status)) {
    return null;
  }

  return status >= 400 && status <= 599 ? status : null;
};

const toHttpError = (err: unknown): HttpError => {
  if (isHttpError(err)) {
    return err;
  }

  if (isHttpStatusError(err)) {
    const status = getHttpStatus(err);

    if (err.type === 'entity.parse.failed' && status === 400) {
      return new HttpError(400, 'InvalidJson', 'Request body contains invalid JSON', {
        cause: err,
      });
    }

    if (err.type === 'entity.too.large' && status === 413) {
      return new HttpError(413, 'PayloadTooLarge', 'Request body is too large', {
        cause: err,
      });
    }

    if (status !== null && status < 500 && err.expose !== false) {
      return new HttpError(status, 'BadRequest', err.message, { cause: err });
    }
  }

  return new HttpError(500, 'InternalServerError', 'Unexpected error', { cause: err });
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NotFound', `Route ${req.method} ${req.originalUrl} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  void _next;

  const httpError = toHttpError(err);

  if (httpError.statusCode >= 500 && !isHttpError(err)) {
    logger.error({ err }, 'Unhandled request error');
  }

  const response: ApiErrorResponse = {
    error: httpError.code,
    message: httpError.message,
  };

  if (httpError.statusCode < 500 && httpError.exposeDetails && httpError.details !== undefined) {
    response.details = httpError.details;
  }

  res.status(httpError.statusCode).json(response);
};
