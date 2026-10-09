import type { RequestHandler } from 'express';
import type { ParamsDictionary, Query } from 'express-serve-static-core';

type HttpErrorMapper = (error: unknown) => Error;

export const mapHandlerErrors =
  <
    Params = ParamsDictionary,
    ResponseBody = unknown,
    RequestBody = unknown,
    RequestQuery = Query,
    Locals extends Record<string, unknown> = Record<string, unknown>,
  >(
    mapError: HttpErrorMapper,
    handler: RequestHandler<Params, ResponseBody, RequestBody, RequestQuery, Locals>,
  ): RequestHandler<Params, ResponseBody, RequestBody, RequestQuery, Locals> =>
  (req, res, next) => {
    try {
      return Promise.resolve(handler(req, res, next)).catch((error: unknown) => {
        next(mapError(error));
      });
    } catch (error) {
      return next(mapError(error));
    }
  };
