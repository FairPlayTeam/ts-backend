import type { ResponseConfig, ZodMediaTypeObject } from '@asteasolutions/zod-to-openapi';

type JsonResponseSchema = ZodMediaTypeObject['schema'];

export const jsonResponse = (description: string, schema: JsonResponseSchema): ResponseConfig => ({
  description,
  content: {
    'application/json': {
      schema,
    },
  },
});
