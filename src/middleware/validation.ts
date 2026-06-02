import type { Request, Response, NextFunction } from 'express';
import type { ZodError, ZodType } from 'zod';
import { ValidationError } from '../errors/http.js';

type ParsedRequestParts = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
};

const formatZodErrors = (error: ZodError) =>
  error.issues.map(({ path, message }) => ({
    field: path.map(String).join('.') || 'unknown',
    message,
  }));

const assignRequestPart = <Key extends keyof ParsedRequestParts>(
  req: Request,
  key: Key,
  value: ParsedRequestParts[Key],
): void => {
  Object.defineProperty(req, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

export const validate =
  (schema: ZodType<ParsedRequestParts>) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const body: unknown = req.body;
    const query: unknown = req.query;
    const params: unknown = req.params;

    const result = schema.safeParse({
      body,
      query,
      params,
    });

    if (!result.success) {
      return next(new ValidationError(formatZodErrors(result.error)));
    }

    const parsedData: unknown = result.data;
    const data = parsedData as ParsedRequestParts;

    if ('body' in data) assignRequestPart(req, 'body', data.body);
    if ('query' in data) assignRequestPart(req, 'query', data.query);
    if ('params' in data) assignRequestPart(req, 'params', data.params);

    next();
  };
