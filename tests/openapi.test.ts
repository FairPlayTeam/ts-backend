import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.js';
import { generateOpenApi } from '../src/docs/openapi.js';

describe('OpenAPI generation', () => {
  test('includes auto-loaded routes and Zod request schemas', async () => {
    process.env.DATABASE_URL ??= 'postgresql://user:password@localhost:5432/fairplay';
    process.env.BASE_URL ??= 'http://localhost:3000';

    await createApp({
      allowedOrigins: [],
      baseUrl: 'http://localhost:3000/',
      isProduction: false,
      jsonBodyLimitBytes: 1024 * 1024,
      trustProxy: false,
    });

    const document = generateOpenApi();

    expect(Object.keys(document.paths).sort()).toEqual(['/', '/auth/register', '/health']);
    expect(document.paths['/auth/register']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/register']?.post?.responses?.[413]).toBeDefined();
    expect(document.components?.schemas?.RegisterRequest).toBeDefined();
    expect(document.components?.schemas?.RegisterResponse).toBeDefined();
  });
});
