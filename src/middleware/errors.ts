import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError, isHttpError } from '../errors/http.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NotFound', `Route ${req.method} ${req.originalUrl} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  void _next;

  const httpError = isHttpError(err)
    ? err
    : new HttpError(500, 'InternalServerError', 'Unexpected error', err);

  if (!isHttpError(err)) {
    console.error('Unhandled request error:', err);
  }

  res.status(httpError.statusCode).json({
    error: httpError.code,
    message: httpError.message,
  });
};
