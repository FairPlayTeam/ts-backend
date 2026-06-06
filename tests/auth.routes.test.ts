import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import {
  LOGOUT_SESSION_ID_INVALID_MESSAGE,
  UPDATE_PROFILE_REQUIRED_FIELD_MESSAGE,
  USER_SESSIONS_CURSOR_PAIR_MESSAGE,
} from '../src/controllers/auth.schemas.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { AUTH_SESSION_REQUIRED_MESSAGE } from '../src/middleware/auth.js';
import {
  ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
  ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  DELETE_AVATAR_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import { UPLOAD_FILE_TOO_LARGE_MESSAGE } from '../src/middleware/upload.js';
import { createStubAuthService } from './support/auth.js';

let server: Server;
let baseUrl: string;
let receivedSessionKey: string | undefined;
let receivedProfileRequest: unknown;
let receivedProfileUpdate: unknown;
let receivedResendVerificationRequest: unknown;
let receivedPasswordResetRequest: unknown;
let receivedGetSessionsRequest: unknown;
let receivedExportUserDataRequest: unknown;
let receivedDeleteAccountRequest: unknown;
let receivedAvatarUpload: unknown;
let receivedAvatarDeletion: unknown;

describe('auth routes', () => {
  beforeAll(async () => {
    const authService = createStubAuthService();
    const app = await createApp(
      {
        allowedOrigins: [],
        avatarMaxUploadBytes: 3 * 1024 * 1024,
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
        trustProxy: false,
      },
      {
        authService: {
          ...authService,
          validateSession: async (sessionKey) => {
            receivedSessionKey = sessionKey;
            return authService.validateSession(sessionKey);
          },
          getProfile: async (input) => {
            receivedProfileRequest = input;
            return authService.getProfile(input);
          },
          updateProfile: async (input) => {
            receivedProfileUpdate = input;
            return authService.updateProfile(input);
          },
          uploadAvatar: async (input) => {
            receivedAvatarUpload = input;
            return authService.uploadAvatar(input);
          },
          deleteAvatar: async (input) => {
            receivedAvatarDeletion = input;
            return authService.deleteAvatar(input);
          },
          resendVerification: async (input) => {
            receivedResendVerificationRequest = input;
            return authService.resendVerification(input);
          },
          requestPasswordReset: async (input) => {
            receivedPasswordResetRequest = input;
            return authService.requestPasswordReset(input);
          },
          getUserSessions: async (input) => {
            receivedGetSessionsRequest = input;
            return authService.getUserSessions(input);
          },
          exportUserData: async (input) => {
            receivedExportUserDataRequest = input;
            return authService.exportUserData(input);
          },
          deleteAccount: async (input) => {
            receivedDeleteAccountRequest = input;
            return authService.deleteAccount(input);
          },
        },
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

  test('returns the current user for a valid bearer session', async () => {
    receivedSessionKey = undefined;
    receivedProfileRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    expect(observedSessionKey).toBe('test-session-key');
    expect(receivedProfileRequest).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    });
    expect(await response.json()).toEqual({
      user: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
        role: 'user',
        avatarUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
      },
      session: {
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
  });

  test('requires a bearer session for the current user route', async () => {
    const response = await fetch(`${baseUrl}/auth/me`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('exports current user data as downloadable JSON for a valid bearer session', async () => {
    receivedExportUserDataRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/me/export`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(receivedExportUserDataRequest).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      currentSessionId: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    });
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="fairplay-user-data-export.json"',
    );
    expect(response.headers.get('content-type')).toContain('application/json');
    const bodyText = await response.text();
    expect(bodyText).toContain('\n  "exportedAt": "2026-01-01T00:00:00.000Z"');
    expect(bodyText.endsWith('\n')).toBe(true);
    expect(JSON.parse(bodyText)).toEqual({
      exportedAt: '2026-01-01T00:00:00.000Z',
      user: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
        role: 'user',
        isVerified: true,
        isBanned: false,
        bannedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastLogin: '2026-01-01T00:00:00.000Z',
      },
      sessions: [
        {
          id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
          sessionKeySuffix: 'sion-key',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          isActive: true,
          isCurrent: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-31T00:00:00.000Z',
        },
      ],
      emailVerificationToken: null,
      passwordResetToken: null,
    });
  });

  test('requires a bearer session to export current user data', async () => {
    const response = await fetch(`${baseUrl}/auth/me/export`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('deletes the current user account for a valid bearer session', async () => {
    receivedDeleteAccountRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(receivedDeleteAccountRequest).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    });
    expect(await response.json()).toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
    });
  });

  test('requires a bearer session to delete the current user account', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('updates the current user profile for a valid bearer session', async () => {
    receivedProfileUpdate = undefined;

    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        displayName: ' Updated Name ',
        bio: null,
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedProfileUpdate).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      displayName: 'Updated Name',
      bio: null,
    });
    expect(await response.json()).toEqual({
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
      user: {
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Updated Name',
        bio: null,
        role: 'user',
      },
    });
  });

  test('rejects empty profile update payloads', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'body',
          message: UPDATE_PROFILE_REQUIRED_FIELD_MESSAGE,
        },
      ],
    });
  });

  test('requires a bearer session to update the current user profile', async () => {
    const response = await fetch(`${baseUrl}/auth/me`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        displayName: 'Updated Name',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('uploads the current user avatar for a valid bearer session', async () => {
    receivedAvatarUpload = undefined;
    const avatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const form = new FormData();
    form.append('avatar', new Blob([avatarBytes], { type: 'image/png' }), 'avatar.png');

    const response = await fetch(`${baseUrl}/auth/me/avatar`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test-session-key',
      },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(receivedAvatarUpload).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      file: {
        buffer: avatarBytes,
        size: avatarBytes.length,
      },
    });
    expect(await response.json()).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: 'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
        mimeType: 'image/webp',
        sizeBytes: 1234,
        width: 512,
        height: 512,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  test('rejects avatar uploads larger than the HTTP upload limit', async () => {
    receivedAvatarUpload = undefined;
    const form = new FormData();
    form.append(
      'avatar',
      new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: 'image/png' }),
      'avatar.png',
    );

    const response = await fetch(`${baseUrl}/auth/me/avatar`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer test-session-key',
      },
      body: form,
    });

    expect(response.status).toBe(413);
    expect(receivedAvatarUpload).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'PayloadTooLarge',
      message: UPLOAD_FILE_TOO_LARGE_MESSAGE,
    });
  });

  test('requires a bearer session to upload an avatar', async () => {
    const form = new FormData();
    form.append('avatar', new Blob([Buffer.from('avatar')], { type: 'image/png' }), 'avatar.png');

    const response = await fetch(`${baseUrl}/auth/me/avatar`, {
      method: 'PUT',
      body: form,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('deletes the current user avatar for a valid bearer session', async () => {
    receivedAvatarDeletion = undefined;

    const response = await fetch(`${baseUrl}/auth/me/avatar`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(receivedAvatarDeletion).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    });
    expect(await response.json()).toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });
  });

  test('requires a bearer session to delete an avatar', async () => {
    const response = await fetch(`${baseUrl}/auth/me/avatar`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('requests verification resend without requiring a bearer session', async () => {
    receivedResendVerificationRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/resend-verification`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: ' USER@Example.COM ',
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedResendVerificationRequest).toEqual({
      email: 'user@example.com',
    });
    expect(await response.json()).toEqual({
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });
  });

  test('rejects verification resend requests from authenticated users', async () => {
    const response = await fetch(`${baseUrl}/auth/resend-verification`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'user@example.com',
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Conflict',
      message: ALREADY_AUTHENTICATED_VERIFICATION_MESSAGE,
    });
  });

  test('requests password reset without requiring a bearer session', async () => {
    receivedPasswordResetRequest = undefined;

    const response = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: ' USER@Example.COM ',
      }),
    });

    expect(response.status).toBe(200);
    expect(receivedPasswordResetRequest).toEqual({
      email: 'user@example.com',
    });
    expect(await response.json()).toEqual({
      message: RESET_PASSWORD_EMAIL_MESSAGE,
    });
  });

  test('rejects password reset requests from authenticated users', async () => {
    const response = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-session-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'user@example.com',
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Conflict',
      message: ALREADY_AUTHENTICATED_PASSWORD_RESET_MESSAGE,
    });
  });

  test('returns active sessions for a valid bearer session', async () => {
    receivedGetSessionsRequest = undefined;

    const response = await fetch(
      `${baseUrl}/auth/sessions?limit=10&cursorLastUsedAt=2026-01-01T00%3A00%3A00.000Z&cursorId=0d4e55cb-c278-4d74-a192-bf7c10888c7a`,
      {
        headers: {
          authorization: 'Bearer test-session-key',
        },
      },
    );

    expect(receivedGetSessionsRequest).toEqual({
      userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      currentSessionId: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      limit: 10,
      cursor: {
        lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
          sessionKeySuffix: 'sion-key',
          ipAddress: '127.0.0.1',
          userAgent: 'bun-test',
          deviceInfo: 'bun-test',
          isCurrent: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-31T00:00:00.000Z',
        },
      ],
      nextCursor: {
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      },
      total: 1,
    });
  });

  test('rejects malformed active session pagination cursors', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions?cursorLastUsedAt=not-a-date`, {
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'query.cursorLastUsedAt',
          message: 'Invalid ISO datetime',
        },
        {
          field: 'query',
          message: USER_SESSIONS_CURSOR_PAIR_MESSAGE,
        },
      ],
    });
  });

  test('requires a bearer session for the active sessions route', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('logs out all sessions for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/all`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 1,
    });
  });

  test('requires a bearer session to log out all sessions', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/all`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('logs out other sessions for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/others/all`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 1,
    });
  });

  test('requires a bearer session to log out other sessions', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/others/all`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('logs out a specific session for a valid bearer session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/123e4567-e89b-12d3-a456-426614174000`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: LOGOUT_SESSION_SUCCESS_MESSAGE,
      sessionsLoggedOut: 1,
    });
  });

  test('rejects malformed session ids when logging out a specific session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/not-a-session-id`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer test-session-key',
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'params.sessionId',
          message: LOGOUT_SESSION_ID_INVALID_MESSAGE,
        },
      ],
    });
  });

  test('requires a bearer session to log out a specific session', async () => {
    const response = await fetch(`${baseUrl}/auth/sessions/123e4567-e89b-12d3-a456-426614174000`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });
});
