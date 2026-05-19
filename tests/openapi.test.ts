import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.js';
import { generateOpenApi } from '../src/docs/openapi.js';
import { createStubAuthService } from './support/auth.js';

describe('OpenAPI generation', () => {
  test('includes auto-loaded routes and Zod request schemas', async () => {
    await createApp(
      {
        allowedOrigins: [],
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        trustProxy: false,
      },
      { authService: createStubAuthService() },
    );

    const document = generateOpenApi();

    expect(Object.keys(document.paths).sort()).toEqual([
      '/',
      '/auth/login',
      '/auth/me',
      '/auth/register',
      '/auth/resend-verification',
      '/auth/sessions',
      '/auth/sessions/all',
      '/auth/sessions/others/all',
      '/auth/sessions/{sessionId}',
      '/auth/verify-email',
      '/health',
    ]);
    expect(document.paths['/auth/login']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/login']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/login']?.post?.responses?.[403]).toBeDefined();
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'Session key',
      description: 'Paste the sessionKey returned by /auth/login or /auth/verify-email.',
    });
    expect(document.paths['/auth/me']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions/all']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.parameters).toEqual([
      expect.objectContaining({
        name: 'sessionId',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/register']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/register']?.post?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/verify-email']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/verify-email']?.post?.responses?.[400]).toBeDefined();
    expect(
      document.paths['/auth/verify-email']?.post?.responses?.[400]?.content?.['application/json']
        ?.schema,
    ).toEqual({
      $ref: '#/components/schemas/ApiOrValidationError',
    });
    expect(document.components?.schemas?.LoginRequest).toBeDefined();
    expect(document.components?.schemas?.LoginResponse).toBeDefined();
    expect(document.components?.schemas?.CurrentUserResponse).toBeDefined();
    expect(document.components?.schemas?.ApiOrValidationError).toBeDefined();
    expect(document.components?.schemas?.RegisterRequest).toBeDefined();
    expect(document.components?.schemas?.RegisterResponse).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationRequest).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationResponse).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailRequest).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailResponse).toBeDefined();
    expect(document.components?.schemas?.UserSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutAllSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutOtherSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutSessionResponse).toBeDefined();
  });
});
