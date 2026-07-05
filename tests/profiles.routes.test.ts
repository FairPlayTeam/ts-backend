import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { PublicProfileNotFoundError } from '../src/services/profiles.errors.js';
import type { GetPublicProfileInput, ProfilesPorts } from '../src/services/profiles.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';

let server: Server;
let baseUrl: string;
let receivedProfileRequest: GetPublicProfileInput | undefined;

describe('profiles routes', () => {
  beforeAll(async () => {
    const profilesService = createStubProfilesService();
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
      {
        adminService: createStubAdminService(),
        authService: createStubAuthService(),
        profilesService: {
          ...profilesService,
          getPublicProfile: async (input) => {
            receivedProfileRequest = input;

            if (input.username === 'missing_user') {
              throw new PublicProfileNotFoundError();
            }

            return profilesService.getPublicProfile(input);
          },
        } satisfies ProfilesPorts,
      },
    );

    server = app.listen(0);
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }

    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  });

  test('returns a public profile without requiring a session', async () => {
    receivedProfileRequest = undefined;

    const response = await fetch(`${baseUrl}/profiles/FairPlay_User`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedProfileRequest = receivedProfileRequest as GetPublicProfileInput | undefined;
    expect(observedProfileRequest).toEqual({
      username: 'fairplay_user',
    });
    expect(await response.json()).toEqual({
      profile: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        bio: 'Sharing project updates with my subscribers.',
        avatarUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
        bannerUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/banner/current-banner.webp',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  test('maps missing public profiles to not found', async () => {
    receivedProfileRequest = undefined;

    const response = await fetch(`${baseUrl}/profiles/missing_user`);

    expect(response.status).toBe(404);
    const observedProfileRequest = receivedProfileRequest as GetPublicProfileInput | undefined;
    expect(observedProfileRequest).toEqual({
      username: 'missing_user',
    });
    expect(await response.json()).toEqual({
      error: 'NotFound',
      message: 'Public profile not found',
    });
  });

  test('rejects invalid usernames before calling the profiles service', async () => {
    receivedProfileRequest = undefined;

    const response = await fetch(`${baseUrl}/profiles/invalid-username`);

    expect(response.status).toBe(400);
    expect(receivedProfileRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'params.username',
          message: 'Username may only contain letters, numbers, and underscores',
        },
      ],
    });
  });
});
