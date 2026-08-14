import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { API_ERROR_CODES, REQUEST_VALIDATION_FAILED_MESSAGE } from '../errors/http.js';
import { z } from './zod.js';

export type RouteDoc = RouteConfig & { operationId: string };

export const ApiErrorSchema = z
  .object({
    error: z.enum(API_ERROR_CODES),
    message: z.string(),
  })
  .openapi('ApiError');

const ValidationErrorDetailSchema = z
  .object({
    field: z.string().openapi({ example: 'body.email' }),
    message: z.string(),
  })
  .openapi('ValidationErrorDetail');

export const ValidationErrorSchema = z
  .object({
    error: z.string().openapi({ example: 'ValidationError' }),
    message: z.string().openapi({ example: REQUEST_VALIDATION_FAILED_MESSAGE }),
    details: z.array(ValidationErrorDetailSchema),
  })
  .openapi('ValidationError');

export const ApiOrValidationErrorSchema = z
  .union([ApiErrorSchema, ValidationErrorSchema])
  .openapi('ApiOrValidationError');

const registerSharedComponents = (registry: OpenAPIRegistry): void => {
  registry.register('ApiError', ApiErrorSchema);
  registry.register('ValidationErrorDetail', ValidationErrorDetailSchema);
  registry.register('ValidationError', ValidationErrorSchema);
  registry.register('ApiOrValidationError', ApiOrValidationErrorSchema);

  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Session key',
    description: 'Paste the sessionKey returned by /auth/login or /auth/verify-email.',
  });
};

export const createOpenApiRegistry = (routeDocs: readonly RouteDoc[]): OpenAPIRegistry => {
  const registry = new OpenAPIRegistry();
  const registeredPaths = new Set<string>();
  const registeredOperationIds = new Set<string>();

  registerSharedComponents(registry);

  for (const doc of routeDocs) {
    const key = `${doc.method.toUpperCase()} ${doc.path}`;

    if (registeredPaths.has(key)) {
      throw new Error(`OpenAPI route already registered: ${key}`);
    }

    if (registeredOperationIds.has(doc.operationId)) {
      throw new Error(`OpenAPI operationId already registered: ${doc.operationId}`);
    }

    registeredPaths.add(key);
    registeredOperationIds.add(doc.operationId);
    registry.registerPath(doc);
  }

  return registry;
};
