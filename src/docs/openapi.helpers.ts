import type {
  ResponseConfig,
  RouteConfig,
  ZodMediaTypeObject,
} from '@asteasolutions/zod-to-openapi';

type JsonResponseSchema = ZodMediaTypeObject['schema'];
type RequestConfig = NonNullable<RouteConfig['request']>;
type RequestBodyConfig = NonNullable<RequestConfig['body']>;
type RequestBodySchema = ZodMediaTypeObject['schema'];

export const jsonResponse = (description: string, schema: JsonResponseSchema): ResponseConfig => ({
  description,
  content: {
    'application/json': {
      schema,
    },
  },
});

const requestBody = (contentType: string, schema: RequestBodySchema): RequestBodyConfig => ({
  required: true,
  content: {
    [contentType]: {
      schema,
    },
  },
});

export const jsonRequest = (schema: RequestBodySchema): RequestConfig => ({
  body: requestBody('application/json', schema),
});

export const multipartFormDataRequest = (schema: RequestBodySchema): RequestConfig => ({
  body: requestBody('multipart/form-data', schema),
});
