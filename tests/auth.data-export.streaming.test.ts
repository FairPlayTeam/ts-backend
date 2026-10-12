import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE } from '../src/middleware/userAccountOperationGuard.js';
import { createAuthService } from '../src/modules/auth/index.js';
import type { AuthHttpPort, AuthSessionValidationPort } from '../src/modules/auth/index.js';

type AuthRouteService = AuthHttpPort & AuthSessionValidationPort;
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubCommentsService } from './support/comments.js';
import { createStubVideoUploadsService, createStubVideosService } from './support/videos.js';
import { createTestDeps, fixedNow, type AuthDeps } from './support/authService.js';

const activeServers = new Set<Server>();

type AccountOperationOverrides = Partial<
  Pick<AuthRouteService, 'deleteAccount' | 'exportUserData'>
>;

const startAccountOperationApp = async (
  overrides: AccountOperationOverrides,
): Promise<{ baseUrl: string; server: Server }> => {
  const authService = createStubAuthService();
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
      authService: { ...authService, ...overrides },
      commentsService: createStubCommentsService(),
      profilesService: createStubProfilesService(),
      videosService: createStubVideosService(),
      videoUploadsService: createStubVideoUploadsService(),
    },
  );
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port');
  }

  activeServers.add(server);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    server,
  };
};

const startExportApp = (exportUserData: AuthRouteService['exportUserData']) =>
  startAccountOperationApp({ exportUserData });

const closeServer = async (server: Server): Promise<void> => {
  activeServers.delete(server);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
};

const exportRequest = (baseUrl: string) =>
  fetch(`${baseUrl}/auth/me/export`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-session-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ currentPassword: 'Password1!' }),
  });

const deleteAccountRequest = (baseUrl: string) =>
  fetch(`${baseUrl}/auth/me`, {
    method: 'DELETE',
    headers: {
      authorization: 'Bearer test-session-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ currentPassword: 'Password1!' }),
  });

const hostileExportFields = {
  passwordHash: 'hostile-password-hash',
  sessionKeyHash: 'hostile-session-key-hash',
  objectKey: 'hostile-storage-object-key',
  externalResourceTargetId: 'hostile-reconciliation-target-id',
  internalMarker: 'hostile-internal-marker',
};

const addHostileExportFields = <T extends object>(value: T) => ({
  ...value,
  ...hostileExportFields,
});

const addHostileExportFieldsToItems = async function* <T extends object>(
  values: AsyncIterable<T>,
): AsyncIterable<T & typeof hostileExportFields> {
  for await (const value of values) {
    yield addHostileExportFields(value);
  }
};

describe('personal data export streaming', () => {
  afterEach(async () => {
    await Promise.all([...activeServers].map(closeServer));
  });

  test('streams only explicitly whitelisted fields from hostile export records', async () => {
    const baseService = createStubAuthService();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date('2026-01-08T00:00:00.000Z');
    const { baseUrl, server } = await startExportApp(async (input) => {
      const result = await baseService.exportUserData(input);

      return {
        ...addHostileExportFields(result),
        user: addHostileExportFields(result.user),
        emailVerificationToken: addHostileExportFields({
          id: 'verification-token-id',
          createdAt: timestamp,
          expiresAt,
        }),
        passwordResetToken: addHostileExportFields({
          id: 'password-reset-token-id',
          createdAt: timestamp,
          expiresAt,
        }),
        following: addHostileExportFieldsToItems(result.following),
        followers: addHostileExportFieldsToItems(result.followers),
        videos: addHostileExportFieldsToItems(result.videos),
        videoRatings: addHostileExportFieldsToItems(result.videoRatings),
        videoViews: addHostileExportFieldsToItems(result.videoViews),
        comments: addHostileExportFieldsToItems(result.comments),
        commentLikes: addHostileExportFieldsToItems(result.commentLikes),
        sessions: addHostileExportFieldsToItems(result.sessions),
      };
    });

    const response = await exportRequest(baseUrl);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({
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
        banReason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastLogin: '2026-01-01T00:00:00.000Z',
      },
      emailVerificationToken: {
        id: 'verification-token-id',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      },
      passwordResetToken: {
        id: 'password-reset-token-id',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      },
      following: [
        {
          username: 'followed_user',
          displayName: 'Followed User',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      followers: [
        {
          username: 'follower_user',
          displayName: 'Follower User',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      videos: [
        {
          publicId: 'vid_01JGF2KQ4X8T7M6N5P3R2S1ABC',
          title: 'Exported video',
          description: null,
          tags: [],
          license: 'all_rights_reserved',
          visibility: 'unlisted',
          allowComments: true,
          processingStatus: 'ready',
          moderationStatus: 'approved',
          durationSeconds: 120,
          width: 1920,
          height: 1080,
          viewCount: 4,
          ratingCount: 1,
          commentCount: 2,
          publishedAt: '2026-01-01T00:00:00.000Z',
          rejectedAt: null,
          rejectionReason: null,
          deletionRequestedAt: null,
          deletionReason: null,
          deletionOrigin: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      videoRatings: [
        {
          videoId: '33333333-3333-4333-8333-333333333333',
          value: 5,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      videoViews: [
        {
          videoId: '33333333-3333-4333-8333-333333333333',
          viewedOn: '2026-01-01',
        },
      ],
      comments: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          videoId: '33333333-3333-4333-8333-333333333333',
          content: 'An exported comment.',
          createdAt: '2026-01-01T00:00:00.000Z',
          deletedAt: null,
          rootId: null,
          replyingToCommentId: null,
        },
      ],
      commentLikes: [
        {
          commentId: '44444444-4444-4444-8444-444444444444',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
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
    });
    expect(body).not.toContain('hostile-');

    await closeServer(server);
  });

  test('holds the per-user lock until the streamed response finishes', async () => {
    const baseService = createStubAuthService();
    let enterFirstPage: (() => void) | undefined;
    let releaseFirstPage: (() => void) | undefined;
    const firstPageEntered = new Promise<void>((resolve) => {
      enterFirstPage = resolve;
    });
    const firstPageReleased = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    let exportCalls = 0;
    const { baseUrl, server } = await startExportApp(async (input) => {
      const result = await baseService.exportUserData(input);
      exportCalls += 1;

      if (exportCalls !== 1) {
        return result;
      }

      return {
        ...result,
        videoRatings: {
          async *[Symbol.asyncIterator]() {
            enterFirstPage?.();
            await firstPageReleased;
            yield* result.videoRatings;
          },
        },
      };
    });

    const firstResponse = await exportRequest(baseUrl);
    await firstPageEntered;

    const concurrentResponse = await exportRequest(baseUrl);
    expect(concurrentResponse.status).toBe(409);
    expect(await concurrentResponse.json()).toEqual({
      error: 'Conflict',
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });
    expect(exportCalls).toBe(1);

    releaseFirstPage?.();
    await expect(firstResponse.json()).resolves.toMatchObject({
      videoRatings: expect.any(Array),
      videoViews: expect.any(Array),
      comments: expect.any(Array),
      sessions: expect.any(Array),
    });

    const nextResponse = await exportRequest(baseUrl);
    expect(nextResponse.status).toBe(200);
    await nextResponse.arrayBuffer();
    expect(exportCalls).toBe(2);

    await closeServer(server);
  });

  test('rejects account deletion while a personal data export is streaming', async () => {
    const baseService = createStubAuthService();
    const firstPageEntered = Promise.withResolvers<void>();
    const releaseFirstPage = Promise.withResolvers<void>();
    let deleteCalls = 0;
    const { baseUrl, server } = await startAccountOperationApp({
      async exportUserData(input) {
        const result = await baseService.exportUserData(input);

        return {
          ...result,
          videoRatings: {
            async *[Symbol.asyncIterator]() {
              firstPageEntered.resolve();
              await releaseFirstPage.promise;
              yield* result.videoRatings;
            },
          },
        };
      },
      async deleteAccount(input) {
        deleteCalls += 1;
        return baseService.deleteAccount(input);
      },
    });

    const exportResponse = await exportRequest(baseUrl);
    await firstPageEntered.promise;

    const deletionConflict = await deleteAccountRequest(baseUrl);
    expect(deletionConflict.status).toBe(409);
    expect(await deletionConflict.json()).toEqual({
      error: 'Conflict',
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });
    expect(deleteCalls).toBe(0);

    releaseFirstPage.resolve();
    await exportResponse.arrayBuffer();

    const deletionResponse = await deleteAccountRequest(baseUrl);
    expect(deletionResponse.status).toBe(200);
    expect(deleteCalls).toBe(1);

    await closeServer(server);
  });

  test('rejects a personal data export while account deletion is in progress', async () => {
    const baseService = createStubAuthService();
    const deletionEntered = Promise.withResolvers<void>();
    const releaseDeletion = Promise.withResolvers<void>();
    let exportCalls = 0;
    const { baseUrl, server } = await startAccountOperationApp({
      async exportUserData(input) {
        exportCalls += 1;
        return baseService.exportUserData(input);
      },
      async deleteAccount(input) {
        deletionEntered.resolve();
        await releaseDeletion.promise;
        return baseService.deleteAccount(input);
      },
    });

    const deletionResponsePromise = deleteAccountRequest(baseUrl);
    await deletionEntered.promise;

    const exportConflict = await exportRequest(baseUrl);
    expect(exportConflict.status).toBe(409);
    expect(await exportConflict.json()).toEqual({
      error: 'Conflict',
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });
    expect(exportCalls).toBe(0);

    releaseDeletion.resolve();
    const deletionResponse = await deletionResponsePromise;
    expect(deletionResponse.status).toBe(200);

    const exportResponse = await exportRequest(baseUrl);
    expect(exportResponse.status).toBe(200);
    await exportResponse.arrayBuffer();
    expect(exportCalls).toBe(1);

    await closeServer(server);
  });

  test('keeps the account-operation lock after disconnect until the deletion handler settles', async () => {
    const baseService = createStubAuthService();
    const deletionEntered = Promise.withResolvers<void>();
    const releaseDeletion = Promise.withResolvers<void>();
    const deletionCompleted = Promise.withResolvers<void>();
    let exportCalls = 0;
    const { baseUrl, server } = await startAccountOperationApp({
      async exportUserData(input) {
        exportCalls += 1;
        return baseService.exportUserData(input);
      },
      async deleteAccount(input) {
        deletionEntered.resolve();
        await releaseDeletion.promise;

        try {
          return await baseService.deleteAccount(input);
        } finally {
          deletionCompleted.resolve();
        }
      },
    });
    const deletionRequest = request(baseUrl)
      .delete('/auth/me')
      .set('Authorization', 'Bearer test-session-key')
      .send({ currentPassword: 'Password1!' });
    const deletionOutcome = deletionRequest.then(
      (response) => response,
      (error: unknown) => error,
    );

    await deletionEntered.promise;
    deletionRequest.abort();
    await deletionOutcome;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const conflict = await exportRequest(baseUrl);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'Conflict',
      message: USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE,
    });
    expect(exportCalls).toBe(0);

    releaseDeletion.resolve();
    await deletionCompleted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const accepted = await exportRequest(baseUrl);
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();
    expect(exportCalls).toBe(1);

    await closeServer(server);
  });

  test('aborts the chunked response when a database page fails after headers were sent', async () => {
    const databaseError = new Error('database failed on the second export page');
    const firstRatingPage = Array.from({ length: 250 }, (_, index) => ({
      videoId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      value: 5,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    }));
    let ratingPageQueries = 0;
    const { deps } = createTestDeps({
      prisma: {
        videoRating: {
          findMany: async () => {
            ratingPageQueries += 1;

            if (ratingPageQueries === 1) {
              return firstRatingPage;
            }

            throw databaseError;
          },
        },
      } as unknown as AuthDeps['prisma'],
    });
    const dataExportService = createAuthService(deps);
    const exportResult = await dataExportService.exportUserData({
      userId: 'user-id',
      currentSessionId: 'session-id',
      currentPassword: 'Password1!',
    });
    const { baseUrl, server } = await startExportApp(async () => exportResult);
    const url = new URL('/auth/me/export', baseUrl);

    const outcome = await new Promise<{
      aborted: boolean;
      body: string;
      ended: boolean;
      statusCode: number | undefined;
      transferEncoding: string | undefined;
    }>((resolve, reject) => {
      const request = http.request(
        url,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-session-key',
            'content-type': 'application/json',
          },
        },
        (response) => {
          let body = '';
          let settled = false;
          const finish = (aborted: boolean, ended: boolean) => {
            if (settled) {
              return;
            }

            settled = true;
            resolve({
              aborted,
              body,
              ended,
              statusCode: response.statusCode,
              transferEncoding: response.headers['transfer-encoding'],
            });
          };

          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.once('aborted', () => finish(true, false));
          response.once('error', () => finish(true, false));
          response.once('end', () => finish(false, true));
        },
      );

      request.once('error', reject);
      request.end(JSON.stringify({ currentPassword: 'Password1!' }));
    });

    expect(outcome.statusCode).toBe(200);
    expect(outcome.transferEncoding).toBe('chunked');
    expect(outcome.aborted).toBe(true);
    expect(outcome.ended).toBe(false);
    expect(outcome.body).toContain('"videoRatings":[');
    expect(() => JSON.parse(outcome.body)).toThrow();
    expect(ratingPageQueries).toBe(2);

    await closeServer(server);
  });
});
