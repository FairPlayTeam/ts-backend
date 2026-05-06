import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
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

export const validate =
  (schema: z.ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      return next(new ValidationError(formatZodErrors(result.error)));
    }

    const data = result.data as ParsedRequestParts;

    if ('body' in data) req.body = data.body;
    if ('query' in data) req.query = data.query as Request['query'];
    if ('params' in data) req.params = data.params as Request['params'];

    next();
  };
