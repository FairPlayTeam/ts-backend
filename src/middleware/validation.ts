import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

type ParsedRequestParts = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
};

const formatZodErrors = (error: ZodError) =>
  error.issues.map(({ path, message }) => ({
    field: path.filter((p): p is string => typeof p === 'string').join('.') || 'unknown',
    message,
  }));

export const validate =
  (schema: z.ZodTypeAny) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Request validation failed',
        details: formatZodErrors(result.error),
      });
      return;
    }

    const data = result.data as ParsedRequestParts;

    if ('body' in data) req.body = data.body;
    if ('query' in data) req.query = data.query as Request['query'];
    if ('params' in data) req.params = data.params as Request['params'];

    next();
  };
