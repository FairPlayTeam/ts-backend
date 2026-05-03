import './zod.js';
import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

export type RouteDoc = RouteConfig;

export const registry = new OpenAPIRegistry();

export const ApiErrorSchema = registry.register(
  'ApiError',
  z.object({
    error: z.string(),
    message: z.string(),
  }),
);

export const ValidationErrorDetailSchema = registry.register(
  'ValidationErrorDetail',
  z.object({
    field: z.string().openapi({ example: 'body.email' }),
    message: z.string(),
  }),
);

export const ValidationErrorSchema = registry.register(
  'ValidationError',
  z.object({
    error: z.string().openapi({ example: 'ValidationError' }),
    message: z.string().openapi({ example: 'Request validation failed' }),
    details: z.array(ValidationErrorDetailSchema),
  }),
);

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const registeredPaths = new Set<string>();

export const registerRoute = (doc: RouteDoc): void => {
  const key = `${doc.method.toUpperCase()} ${doc.path}`;

  if (registeredPaths.has(key)) {
    throw new Error(`OpenAPI route already registered: ${key}`);
  }

  registeredPaths.add(key);
  registry.registerPath(doc);
};
