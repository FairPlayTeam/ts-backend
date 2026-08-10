import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { USER_ACCOUNT_OPERATION_CONFLICT_MESSAGE } from '../src/middleware/userAccountOperationGuard.js';
import { createAuthService } from '../src/services/auth.service.js';
import type { AuthRoutePort } from '../src/services/auth.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';
import { createTestDeps, fixedNow, type AuthDeps } from './support/authService.js';

const activeServers = new Set<Server>();

type AccountOperationOverrides = Partial<Pick<AuthRoutePort, 'deleteAccount' | 'exportUserData'>>;

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
      profilesService: createStubProfilesService(),
      videosService: createStubVideosService(),
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

const startExportApp = (exportUserData: AuthRoutePort['exportUserData']) =>
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

describe('personal data export streaming', () => {
  afterEach(async () => {
    await Promise.all([...activeServers].map(closeServer));
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
