import { describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import {
  EXPENSIVE_AUTH_MUTATION_RATE_LIMIT_MAX,
  PROFILE_MEDIA_UPLOAD_RATE_LIMIT_MAX,
  VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX,
} from '../src/config/constants.js';
import {
  EXPENSIVE_AUTH_MUTATION_RATE_LIMIT_MESSAGE,
  PROFILE_MEDIA_UPLOAD_RATE_LIMIT_MESSAGE,
  VIDEO_COMMENT_MUTATION_RATE_LIMIT_MESSAGE,
} from '../src/middleware/limiters.js';
import type { AuthPorts } from '../src/services/auth.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

type TestServer = {
  baseUrl: string;
  close(): Promise<void>;
};

const createProfileMediaForm = (fieldName: 'avatar' | 'banner'): FormData => {
  const form = new FormData();

  form.append(
    fieldName,
    new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    `${fieldName}.png`,
  );

  return form;
};

const userIdForSessionKey = (sessionKey: string): string =>
  sessionKey === 'second-user-session-key'
    ? '22222222-2222-4222-8222-222222222222'
    : '11111111-1111-4111-8111-111111111111';

const withTokenScopedUsers = (authService: AuthPorts): AuthPorts => ({
  ...authService,
  validateSession: async (sessionKey) => {
    const result = await authService.validateSession(sessionKey);

    if (!result) {
      return null;
    }

    return {
      ...result,
      user: {
        ...result.user,
        id: userIdForSessionKey(sessionKey),
      },
    };
  },
});

const startAuthApp = async (
  authService: AuthPorts,
  videosService = createStubVideosService(),
): Promise<TestServer> => {
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
      authService,
      profilesService: createStubProfilesService(),
      videosService,
    },
  );
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      }),
  };
};

describe('specialized auth rate limiters', () => {
  test('rate limits profile media uploads before calling the upload service', async () => {
    const baseAuthService = createStubAuthService();
    let uploadCalls = 0;
    const server = await startAuthApp(
      withTokenScopedUsers({
        ...baseAuthService,
        uploadAvatar: async (input) => {
          uploadCalls += 1;
          return baseAuthService.uploadAvatar(input);
        },
      }),
    );

    try {
      for (let index = 0; index < PROFILE_MEDIA_UPLOAD_RATE_LIMIT_MAX; index += 1) {
        const response = await fetch(`${server.baseUrl}/auth/me/avatar`, {
          method: 'PUT',
          headers: {
            authorization: 'Bearer media-upload-session-key',
          },
          body: createProfileMediaForm('avatar'),
        });

        expect(response.status).toBe(200);
      }

      const blockedResponse = await fetch(`${server.baseUrl}/auth/me/avatar`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer media-upload-session-key',
        },
        body: createProfileMediaForm('avatar'),
      });

      expect(blockedResponse.status).toBe(429);
      expect(await blockedResponse.json()).toEqual({
        error: 'TooManyRequests',
        message: PROFILE_MEDIA_UPLOAD_RATE_LIMIT_MESSAGE,
      });
      expect(uploadCalls).toBe(PROFILE_MEDIA_UPLOAD_RATE_LIMIT_MAX);
    } finally {
      await server.close();
    }
  });

  test('rate limits costly authenticated mutations per user', async () => {
    const baseAuthService = createStubAuthService();
    let deleteAccountCalls = 0;
    const server = await startAuthApp(
      withTokenScopedUsers({
        ...baseAuthService,
        deleteAccount: async (input) => {
          deleteAccountCalls += 1;
          return baseAuthService.deleteAccount(input);
        },
      }),
    );

    try {
      const deleteAccount = (sessionKey: string) =>
        fetch(`${server.baseUrl}/auth/me`, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${sessionKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ currentPassword: 'Password1!' }),
        });

      for (let index = 0; index < EXPENSIVE_AUTH_MUTATION_RATE_LIMIT_MAX; index += 1) {
        const response = await deleteAccount('first-user-session-key');

        expect(response.status).toBe(200);
      }

      const blockedResponse = await deleteAccount('first-user-session-key');

      expect(blockedResponse.status).toBe(429);
      expect(await blockedResponse.json()).toEqual({
        error: 'TooManyRequests',
        message: EXPENSIVE_AUTH_MUTATION_RATE_LIMIT_MESSAGE,
      });

      const otherUserResponse = await deleteAccount('second-user-session-key');

      expect(otherUserResponse.status).toBe(200);
      expect(deleteAccountCalls).toBe(EXPENSIVE_AUTH_MUTATION_RATE_LIMIT_MAX + 1);
    } finally {
      await server.close();
    }
  });

  test('rate limits comment creation per authenticated user', async () => {
    const server = await startAuthApp(withTokenScopedUsers(createStubAuthService()));
    const createComment = (sessionKey: string) =>
      fetch(`${server.baseUrl}/videos/AbCdEf123_/comments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'A bounded comment.' }),
      });

    try {
      for (let index = 0; index < VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX; index += 1) {
        const response = await createComment('first-user-session-key');

        expect(response.status).toBe(201);
      }

      const blockedResponse = await createComment('first-user-session-key');

      expect(blockedResponse.status).toBe(429);
      expect(await blockedResponse.json()).toEqual({
        error: 'TooManyRequests',
        message: VIDEO_COMMENT_MUTATION_RATE_LIMIT_MESSAGE,
      });

      await expect(createComment('second-user-session-key')).resolves.toMatchObject({
        status: 201,
      });
    } finally {
      await server.close();
    }
  });

  test('rate limits a burst of random comment deletions before calling the video service', async () => {
    const baseVideosService = createStubVideosService();
    let deleteCommentCalls = 0;
    const server = await startAuthApp(withTokenScopedUsers(createStubAuthService()), {
      ...baseVideosService,
      deleteVideoComment: async () => {
        deleteCommentCalls += 1;
      },
    });
    const requestCount = VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX + 20;

    try {
      const responses = await Promise.all(
        Array.from({ length: requestCount }, (_, index) => {
          const commentId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;

          return fetch(`${server.baseUrl}/videos/AbCdEf123_/comments/${commentId}`, {
            method: 'DELETE',
            headers: {
              authorization: 'Bearer first-user-session-key',
            },
          });
        }),
      );
      const accepted = responses.filter(({ status }) => status === 204);
      const rateLimited = responses.filter(({ status }) => status === 429);

      expect(accepted).toHaveLength(VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX);
      expect(rateLimited).toHaveLength(requestCount - VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX);
      expect(deleteCommentCalls).toBe(VIDEO_COMMENT_MUTATION_RATE_LIMIT_MAX);
      expect(rateLimited[0]?.headers.get('cache-control')).toBe('no-store');
      await expect(rateLimited[0]?.json()).resolves.toEqual({
        error: 'TooManyRequests',
        message: VIDEO_COMMENT_MUTATION_RATE_LIMIT_MESSAGE,
      });
    } finally {
      await server.close();
    }
  });
});
