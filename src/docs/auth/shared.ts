import { ApiErrorSchema, ApiOrValidationErrorSchema } from '../registry.js';
import { jsonRequest, jsonResponse, multipartFormDataRequest } from '../openapi.helpers.js';
import { sensitiveActionReauthenticationBodySchema } from '../../controllers/auth.schemas.js';

type ResponseSchema = Parameters<typeof jsonResponse>[1];

export { jsonRequest, jsonResponse, multipartFormDataRequest };

export const commonErrorResponses = {
  413: jsonResponse('Payload too large', ApiErrorSchema),

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
};

export const badRequestErrorResponse = {
  400: jsonResponse('Bad request', ApiOrValidationErrorSchema),
};

export const authRequiredErrorResponse = {
  401: jsonResponse('Missing, invalid, or expired session', ApiErrorSchema),
};

export const currentUserNotFoundErrorResponse = {
  404: jsonResponse('Authenticated user not found', ApiErrorSchema),
};

export const serviceUnavailableErrorResponse = {
  503: jsonResponse('Object storage unavailable', ApiErrorSchema),
};

export const sensitiveActionReauthenticationRequest = jsonRequest(
  sensitiveActionReauthenticationBodySchema,
);

export const sensitiveActionErrorResponses = (forbiddenDescription: string) => ({
  ...badRequestErrorResponse,

  ...authRequiredErrorResponse,

  403: jsonResponse(forbiddenDescription, ApiErrorSchema),

  ...commonErrorResponses,
});

export const logoutSessionsSensitiveActionResponses = sensitiveActionErrorResponses(
  'Account is not allowed to log out sessions',
);

export const userMediaUploadResponses = (
  successMessage: string,
  responseSchema: ResponseSchema,
) => ({
  200: jsonResponse(successMessage, responseSchema),

  ...badRequestErrorResponse,

  ...authRequiredErrorResponse,

  ...currentUserNotFoundErrorResponse,

  413: jsonResponse('Uploaded file too large', ApiErrorSchema),

  ...serviceUnavailableErrorResponse,

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
});

export const userMediaDeleteResponses = (
  successMessage: string,
  responseSchema: ResponseSchema,
) => ({
  200: jsonResponse(successMessage, responseSchema),

  ...authRequiredErrorResponse,

  ...serviceUnavailableErrorResponse,

  429: jsonResponse('Too many requests', ApiErrorSchema),

  500: jsonResponse('Internal server error', ApiErrorSchema),
});
