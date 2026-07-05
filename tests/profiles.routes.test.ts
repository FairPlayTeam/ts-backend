import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { AUTH_SESSION_REQUIRED_MESSAGE } from '../src/middleware/auth.js';
import { PublicProfileNotFoundError } from '../src/services/profiles.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../src/services/profiles/profiles.messages.js';
import type {
  FollowPublicProfileInput,
  GetPublicProfileInput,
  ProfilesPorts,
} from '../src/services/profiles.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';

let server: Server;
let baseUrl: string;
let receivedProfileRequest: GetPublicProfileInput | undefined;
let receivedFollowProfileRequest: FollowPublicProfileInput | undefined;
let receivedUnfollowProfileRequest: FollowPublicProfileInput | undefined;
let receivedSessionKey: string | undefined;

describe('profiles routes', () => {
  beforeAll(async () => {
    const authService = createStubAuthService();
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
        authService: {
          ...authService,
          validateSession: async (sessionKey) => {
            receivedSessionKey = sessionKey;

            return authService.validateSession(sessionKey);
          },
        },
        profilesService: {
          ...profilesService,
          getPublicProfile: async (input) => {
            receivedProfileRequest = input;

            if (input.username === 'missing_user') {
              throw new PublicProfileNotFoundError();
            }

            return profilesService.getPublicProfile(input);
          },
          followPublicProfile: async (input) => {
            receivedFollowProfileRequest = input;

            if (input.username === 'missing_user') {
              throw new PublicProfileNotFoundError();
            }

            return profilesService.followPublicProfile(input);
          },
          unfollowPublicProfile: async (input) => {
            receivedUnfollowProfileRequest = input;

            if (input.username === 'missing_user') {
              throw new PublicProfileNotFoundError();
            }

            return profilesService.unfollowPublicProfile(input);
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
        followerCount: 12,
        followingCount: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  test('follows a public profile with an authenticated session', async () => {
    receivedFollowProfileRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/profiles/Creator_User/follow`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedFollowProfileRequest = receivedFollowProfileRequest as
      | FollowPublicProfileInput
      | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedFollowProfileRequest).toEqual({
      actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      username: 'creator_user',
    });
    expect(await response.json()).toEqual({
      message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        bio: 'Sharing project updates with my subscribers.',
        avatarUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
        bannerUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/banner/current-banner.webp',
        followerCount: 13,
        followingCount: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  test('unfollows a public profile with an authenticated session', async () => {
    receivedUnfollowProfileRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/profiles/Creator_User/follow`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer route-session-key',
      },
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedUnfollowProfileRequest = receivedUnfollowProfileRequest as
      | FollowPublicProfileInput
      | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedUnfollowProfileRequest).toEqual({
      actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      username: 'creator_user',
    });
    expect(await response.json()).toEqual({
      message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
      profile: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        bio: 'Sharing project updates with my subscribers.',
        avatarUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
        bannerUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/banner/current-banner.webp',
        followerCount: 12,
        followingCount: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  test('requires a session before following a profile', async () => {
    receivedFollowProfileRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/profiles/fairplay_user/follow`, {
      method: 'POST',
    });

    expect(response.status).toBe(401);
    expect(receivedSessionKey).toBeUndefined();
    expect(receivedFollowProfileRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
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
