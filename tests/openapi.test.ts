import { describe, expect, test } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { jsonResponse } from '../src/docs/openapi.helpers.js';
import { generateOpenApi } from '../src/docs/openapi.js';
import type { RouteDoc } from '../src/docs/registry.js';
import { z } from '../src/docs/zod.js';
import { AUTH_ROLES } from '../src/services/auth.roles.js';
import { createStubAuthService } from './support/auth.js';

describe('OpenAPI generation', () => {
  test('includes auto-loaded routes and Zod request schemas', async () => {
    const app = await createApp(
      {
        allowedOrigins: [],
        profileMediaMaxUploadBytes: 3 * 1024 * 1024,
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
        trustProxy: false,
      },
      { authService: createStubAuthService() },
    );

    const response = await request(app).get('/openapi.json').expect(200);
    const document = response.body;

    expect(Object.keys(document.paths).sort()).toEqual([
      '/',
      '/auth/forgot-password',
      '/auth/login',
      '/auth/me',
      '/auth/me/avatar',
      '/auth/me/banner',
      '/auth/me/export',
      '/auth/register',
      '/auth/resend-verification',
      '/auth/reset-password',
      '/auth/sessions',
      '/auth/sessions/all',
      '/auth/sessions/others/all',
      '/auth/sessions/{sessionId}',
      '/auth/verify-email',
      '/health',
      '/health/live',
      '/health/ready',
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
    expect(document.paths['/auth/me']?.get?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.requestBody).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.patch?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.requestBody).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.requestBody?.content).toHaveProperty(
      'multipart/form-data',
    );
    expect(document.paths['/auth/me/avatar']?.put?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me/avatar']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.requestBody?.content).toHaveProperty(
      'multipart/form-data',
    );
    expect(document.paths['/auth/me/banner']?.put?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/banner']?.put?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me/banner']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/export']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorLastUsedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorId',
          in: 'query',
        }),
      ]),
    );
    expect(document.paths['/auth/sessions']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.requestBody).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.requestBody).toEqual(
      document.paths['/auth/sessions/all']?.delete?.requestBody,
    );
    expect(document.paths['/auth/sessions/others/all']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[403]).toBeDefined();
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
    expect(document.paths['/auth/forgot-password']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/forgot-password']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/forgot-password']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/forgot-password']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/reset-password']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/resend-verification']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.responses?.[409]).toBeDefined();
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
    expect(document.components?.schemas?.LoginResponse?.properties?.user?.properties?.role).toEqual(
      {
        type: 'string',
        enum: [...AUTH_ROLES],
        example: 'user',
      },
    );
    expect(document.components?.schemas?.CurrentUserResponse).toBeDefined();
    expect(
      document.components?.schemas?.CurrentUserResponse?.properties?.user?.properties?.avatarUrl,
    ).toBeDefined();
    expect(
      document.components?.schemas?.CurrentUserResponse?.properties?.user?.properties?.bannerUrl,
    ).toBeDefined();
    expect(document.components?.schemas?.ApiOrValidationError).toBeDefined();
    expect(document.components?.schemas?.UpdateProfileRequest).toBeDefined();
    expect(document.components?.schemas?.UpdateProfileResponse).toBeDefined();
    expect(document.components?.schemas?.UploadAvatarRequest).toBeDefined();
    expect(document.components?.schemas?.UploadAvatarResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteAvatarResponse).toBeDefined();
    expect(document.components?.schemas?.UploadBannerRequest).toBeDefined();
    expect(document.components?.schemas?.UploadBannerResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteBannerResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteAccountResponse).toBeDefined();
    expect(document.components?.schemas?.RegisterRequest).toBeDefined();
    expect(document.components?.schemas?.RegisterResponse).toBeDefined();
    expect(document.components?.schemas?.RequestPasswordResetRequest).toBeDefined();
    expect(document.components?.schemas?.RequestPasswordResetResponse).toBeDefined();
    expect(document.components?.schemas?.ResetPasswordRequest).toBeDefined();
    expect(document.components?.schemas?.ResetPasswordResponse).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationRequest).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationResponse).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailRequest).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailResponse).toBeDefined();
    expect(document.components?.schemas?.UserSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.UserDataExportResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutAllSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutOtherSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutSessionResponse).toBeDefined();
    expect(document.paths['/health/live']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/health/ready']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/health/ready']?.get?.responses?.[503]).toBeDefined();
    expect(document.components?.schemas?.LivenessResponse).toBeDefined();
    expect(document.components?.schemas?.ReadinessResponse).toBeDefined();
    expect(document.components?.schemas?.ReadinessUnavailableResponse).toBeDefined();
  });

  test('does not leak route docs between generated documents', () => {
    const isolatedRouteDocs = [
      {
        method: 'get',
        path: '/isolated',
        responses: {
          200: jsonResponse(
            'Isolated response',
            z
              .object({
                ok: z.literal(true).openapi({ example: true }),
              })
              .openapi('IsolatedOpenApiResponse'),
          ),
        },
      },
    ] satisfies RouteDoc[];

    const documentWithRoute = generateOpenApi({ routeDocs: isolatedRouteDocs });
    const documentWithoutRoute = generateOpenApi({ routeDocs: [] });

    expect(documentWithRoute.paths['/isolated']).toBeDefined();
    expect(documentWithRoute.components?.schemas?.IsolatedOpenApiResponse).toBeDefined();
    expect(documentWithoutRoute.paths['/isolated']).toBeUndefined();
    expect(documentWithoutRoute.components?.schemas?.IsolatedOpenApiResponse).toBeUndefined();
  });
});
