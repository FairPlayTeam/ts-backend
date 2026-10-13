import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { hashToken } from '../../src/lib/crypto.js';
import {
  InvalidCredentialsError,
  INVALID_CREDENTIALS_MESSAGE,
} from '../../src/modules/auth/errors.js';
import { createVideoPublicId } from '../../src/modules/videos/shared/publicId.js';
import { coordinateLockInterleaving, coordinateWhilePaused } from './support/asyncBarriers.js';
import { holdAuthTransaction } from './support/authTransactions.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationApp,
  createIntegrationAuthService,
  createPrismaClient,
  createPostgresApplicationName,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const EMAIL = 'sensitive-race@example.com';
const USERNAME = 'sensitive_race';
const NEXT_PASSWORD = 'ResetPassword2!';
const actions = ['delete', 'export', 'logout-all', 'logout-others'] as const;
type Action = (typeof actions)[number];
type IntegrationApp = Awaited<ReturnType<typeof createIntegrationApp>>;

const startAction = (app: IntegrationApp, action: Action, sessionKey: string) => {
  const client = request(app);
  const operation =
    action === 'export'
      ? client.post('/auth/me/export')
      : client.delete(
          action === 'delete'
            ? '/auth/me'
            : action === 'logout-all'
              ? '/auth/sessions/all'
              : '/auth/sessions/others/all',
        );
  return operation
    .set('Authorization', `Bearer ${sessionKey}`)
    .send({ currentPassword: INITIAL_PASSWORD })
    .then((response) => response);
};

const expectInvalidCredentials = (response: request.Response) => {
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'Unauthorized', message: INVALID_CREDENTIALS_MESSAGE });
};

describe('sensitive action transaction security integration', () => {
  let runtime: TestRuntime;
  beforeAll(async () => {
    runtime = await startRuntime();
  });
  beforeEach(async () => {
    await resetState(runtime);
  });
  afterAll(async () => {
    await stopRuntime(runtime);
  });

  const setup = async () => {
    const owner = await createVerifiedSession(runtime, { email: EMAIL, username: USERNAME });
    const session = await runtime.prisma.session.findUniqueOrThrow({
      where: { sessionKey: hashToken(owner.sessionKey) },
      select: { id: true },
    });
    const video = await runtime.prisma.video.create({
      data: {
        ownerId: owner.userId,
        publicId: createVideoPublicId(),
        title: 'Retained account data',
      },
    });
    await runtime.authService.requestPasswordReset({ email: EMAIL });
    const code = runtime.delivered.passwordReset.at(-1)?.token;
    if (!code) throw new Error('Reset code was not delivered');
    return { owner: { ...owner, sessionId: session.id }, video, code };
  };

  test('preserves the invalid-code HTTP error for a concurrent duplicate reset', async () => {
    const { code } = await setup();
    const gate = holdAuthTransaction(runtime.prisma, 'before-commit');
    const resetService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const firstApp = await createIntegrationApp(runtime, { authService: resetService });
    const secondApp = await createIntegrationApp(runtime);
    const [firstResponse, secondResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'first reset applied before commit',
      firstOperation: request(firstApp)
        .post('/auth/reset-password')
        .send({ email: EMAIL, code, password: NEXT_PASSWORD })
        .then((response) => response),
      firstPaused: gate.paused,
      releaseFirst: gate.release,
      secondLockDescription: 'duplicate reset user lock behind first reset',
      startSecond: () =>
        request(secondApp)
          .post('/auth/reset-password')
          .send({ email: EMAIL, code, password: 'DifferentPassword3!' })
          .then((response) => response),
      waitForSecondLock: (signal) =>
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: [runtime.postgresApplicationName],
          expectedCount: 1,
          queryFragments: ['FROM "users"', 'FOR UPDATE'],
          signal,
        }),
    });
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(400);
    expect(secondResponse.body).toEqual({
      error: 'BadRequest',
      message: 'Invalid or expired password reset code.',
    });
    expect(await runtime.prisma.passwordResetToken.count()).toBe(0);
  });

  test.each(actions)(
    'rejects %s when reset commits after bcrypt, preserving a new session',
    async (action) => {
      const { owner, video, code } = await setup();
      const compared = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const authService = createIntegrationAuthService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        runtime.userMediaExternalResources,
        {
          afterPasswordCompare: async () => {
            compared.resolve();
            await release.promise;
          },
        },
      );
      const app = await createIntegrationApp(runtime, { authService });
      const [response, newLogin] = await coordinateWhilePaused({
        firstBarrierDescription: 'sensitive HTTP request authenticated before reset',
        firstOperation: startAction(app, action, owner.sessionKey),
        firstPaused: compared.promise,
        releaseFirst: release.resolve,
        runWhilePaused: async () => {
          await runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD });
          expect(await runtime.authService.validateSession(owner.sessionKey)).toBeNull();
          return runtime.authService.login({ emailOrUsername: USERNAME, password: NEXT_PASSWORD });
        },
        whilePausedDescription: 'reset and new session commit before the request resumes',
      });
      expectInvalidCredentials(response);
      expect(await runtime.prisma.user.count({ where: { id: owner.userId } })).toBe(1);
      expect(await runtime.prisma.video.count({ where: { id: video.id } })).toBe(1);
      expect(await runtime.authService.validateSession(newLogin.sessionKey)).not.toBeNull();
      expect(
        await runtime.prisma.session.count({ where: { userId: owner.userId, isActive: true } }),
      ).toBe(1);
    },
  );

  test.each(actions)('rejects %s waiting on an uncommitted reset user lock', async (action) => {
    const { owner, video, code } = await setup();
    const gate = holdAuthTransaction(runtime.prisma, 'before-commit');
    const resetService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const actionTransactions = holdAuthTransaction(runtime.prisma, 'before-user-read');
    actionTransactions.release();
    let passwordComparisons = 0;
    const actionService = createIntegrationAuthService(
      actionTransactions.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
      {
        afterPasswordCompare: async () => {
          passwordComparisons++;
        },
      },
    );
    const app = await createIntegrationApp(runtime, { authService: actionService });
    const [, response] = await coordinateLockInterleaving({
      firstBarrierDescription: 'reset writes before commit',
      firstOperation: resetService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD }),
      firstPaused: gate.paused,
      releaseFirst: gate.release,
      secondLockDescription: 'sensitive action user lock behind reset',
      startSecond: () => startAction(app, action, owner.sessionKey),
      waitForSecondLock: (signal) =>
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: [runtime.postgresApplicationName],
          expectedCount: 1,
          queryFragments: ['FROM "users"', 'FOR UPDATE'],
          signal,
        }),
    });
    expectInvalidCredentials(response);
    expect(passwordComparisons).toBe(1);
    expect(actionTransactions.transactionCount()).toBe(action === 'delete' ? 2 : 1);
    expect(await runtime.prisma.video.count({ where: { id: video.id } })).toBe(1);
    expect(
      await runtime.prisma.session.count({ where: { userId: owner.userId, isActive: true } }),
    ).toBe(0);
  });

  test.each(
    actions.flatMap((action) => (['ban', 'delete'] as const).map((change) => ({ action, change }))),
  )('rejects $action when account $change commits after bcrypt', async ({ action, change }) => {
    const { owner } = await setup();
    const admin = await createVerifiedSession(runtime, {
      email: 'sensitive-admin@example.com',
      username: 'sensitive_admin',
    });
    await runtime.prisma.user.update({ where: { id: admin.userId }, data: { role: 'admin' } });
    const compared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const authService = createIntegrationAuthService(
      runtime.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
      {
        afterPasswordCompare: async () => {
          compared.resolve();
          await release.promise;
        },
      },
    );
    const app = await createIntegrationApp(runtime, { authService });
    const [response] = await coordinateWhilePaused({
      firstBarrierDescription: 'sensitive HTTP reauthentication before account change',
      firstOperation: startAction(app, action, owner.sessionKey),
      firstPaused: compared.promise,
      releaseFirst: release.resolve,
      runWhilePaused: async () => {
        if (change === 'ban') {
          await runtime.adminService.banAccount({
            actorUserId: admin.userId,
            targetUserId: owner.userId,
            reason: 'Integration test',
          });
        } else {
          await runtime.authService.deleteAccount({
            userId: owner.userId,
            currentPassword: INITIAL_PASSWORD,
          });
        }
      },
      whilePausedDescription: 'account change commits before final credential check',
    });
    if (change === 'delete') expectInvalidCredentials(response);
    else {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: 'Forbidden',
        message: 'This account has been banned',
      });
      expect(
        await runtime.prisma.passwordResetToken.count({ where: { userId: owner.userId } }),
      ).toBe(1);
    }
  });

  test.each(['delete', 'logout-all', 'logout-others'] as const)(
    'reset waits for %s authorized before its effects',
    async (action) => {
      const { owner, code } = await setup();
      const gate = holdAuthTransaction(runtime.prisma, 'before-user-read');
      const authService = createIntegrationAuthService(
        gate.prisma,
        runtime.objectStorage,
        runtime.delivered,
        runtime.userMediaExternalResources,
      );
      const app = await createIntegrationApp(runtime, { authService });
      // Use another connection identity to distinguish reset's lock from page/read transactions.
      const resetApplicationName = createPostgresApplicationName();
      const resetPrisma = createPrismaClient(runtime.databaseUrl, {
        applicationName: resetApplicationName,
      });
      const resetService = createIntegrationAuthService(
        resetPrisma,
        runtime.objectStorage,
        runtime.delivered,
        runtime.userMediaExternalResources,
      );
      try {
        const [response, resetResponse] = await coordinateLockInterleaving({
          firstBarrierDescription:
            'sensitive action holds user lock before credential reread and effects',
          firstOperation: startAction(app, action, owner.sessionKey),
          firstPaused: gate.paused,
          releaseFirst: gate.release,
          secondLockDescription: 'reset user lock behind sensitive action',
          startSecond: async () => {
            try {
              return {
                result: await resetService.resetPassword({
                  email: EMAIL,
                  code,
                  password: NEXT_PASSWORD,
                }),
                error: null,
              };
            } catch (error) {
              return { result: null, error };
            }
          },
          waitForSecondLock: (signal) =>
            waitForPostgresLockWaiters(runtime.prisma, {
              applicationNames: [resetApplicationName],
              expectedCount: 1,
              queryFragments: ['FROM "users"', 'FOR UPDATE'],
              signal,
            }),
        });
        expect(response.status).toBe(200);
        if (action === 'delete') {
          const resetErrorMessage =
            resetResponse.error instanceof Error
              ? resetResponse.error.message
              : 'Unexpected reset outcome';
          expect(resetResponse.error, resetErrorMessage).toMatchObject({
            name: 'InvalidPasswordResetTokenError',
          });
          expect(await runtime.prisma.user.count({ where: { id: owner.userId } })).toBe(0);
        } else {
          expect(resetResponse.error).toBeNull();
          expect(resetResponse.result?.sessionsLoggedOut).toBe(action === 'logout-all' ? 0 : 1);
          expect(await runtime.authService.validateSession(owner.sessionKey)).toBeNull();
        }
      } finally {
        gate.release();
        await resetPrisma.$disconnect();
      }
    },
  );

  test('reset waits for the authorized export metadata read, then invalidates its pages', async () => {
    const { owner, code } = await setup();
    const gate = holdAuthTransaction(runtime.prisma, 'before-user-read');
    const authService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const [result] = await coordinateLockInterleaving({
      firstBarrierDescription: 'export user lock before metadata read',
      firstOperation: authService.exportUserData({
        userId: owner.userId,
        currentSessionId: owner.sessionId,
        currentPassword: INITIAL_PASSWORD,
      }),
      firstPaused: gate.paused,
      releaseFirst: gate.release,
      secondLockDescription: 'reset user lock behind export metadata read',
      startSecond: () =>
        runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD }),
      waitForSecondLock: (signal) =>
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: [runtime.postgresApplicationName],
          expectedCount: 1,
          queryFragments: ['FROM "users"', 'FOR UPDATE'],
          signal,
        }),
    });
    expect(result.user.email).toBe(EMAIL);
    await expect(result.following[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  test('reset waits for an authorized export page read, without holding a lock during iteration', async () => {
    const { owner, code } = await setup();
    const gate = holdAuthTransaction(runtime.prisma, 'before-user-read', { skipTransactions: 1 });
    const authService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const result = await authService.exportUserData({
      userId: owner.userId,
      currentSessionId: owner.sessionId,
      currentPassword: INITIAL_PASSWORD,
    });
    const iterator = result.sessions[Symbol.asyncIterator]();
    try {
      const [firstPageItem] = await coordinateLockInterleaving({
        firstBarrierDescription: 'export page user lock before its session SELECT',
        firstOperation: iterator.next(),
        firstPaused: gate.paused,
        releaseFirst: gate.release,
        secondLockDescription: 'reset user lock behind export session page',
        startSecond: () =>
          runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD }),
        waitForSecondLock: (signal) =>
          waitForPostgresLockWaiters(runtime.prisma, {
            applicationNames: [runtime.postgresApplicationName],
            expectedCount: 1,
            queryFragments: ['FROM "users"', 'FOR UPDATE'],
            signal,
          }),
      });
      expect(firstPageItem.done).toBe(false);
      expect(firstPageItem.value).toMatchObject({ isActive: true, isCurrent: true });
      expect(await runtime.authService.validateSession(owner.sessionKey)).toBeNull();
      expect(gate.transactionCount()).toBe(2);
    } finally {
      await iterator.return?.();
    }
  });

  test.each([
    'following',
    'followers',
    'videos',
    'videoRatings',
    'videoViews',
    'comments',
    'commentLikes',
    'sessions',
  ] as const)(
    'rejects the first %s export page if reset commits after initial metadata',
    async (collection) => {
      const { owner, code } = await setup();
      const result = await runtime.authService.exportUserData({
        userId: owner.userId,
        currentSessionId: owner.sessionId,
        currentPassword: INITIAL_PASSWORD,
      });
      await runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD });
      const iterator = result[collection][Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toBeInstanceOf(InvalidCredentialsError);
    },
  );

  test('rejects the next export page after reset while retaining bounded page reads', async () => {
    const { owner, code } = await setup();
    await runtime.prisma.session.createMany({
      data: Array.from({ length: 250 }, () => ({
        userId: owner.userId,
        sessionKey: hashToken(randomUUID()),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    });
    const result = await runtime.authService.exportUserData({
      userId: owner.userId,
      currentSessionId: owner.sessionId,
      currentPassword: INITIAL_PASSWORD,
    });
    const iterator = result.sessions[Symbol.asyncIterator]();
    for (let index = 0; index < 250; index++) expect((await iterator.next()).done).toBe(false);
    await runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD });
    await expect(iterator.next()).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  test('interrupts the real HTTP export stream when reset commits before its next collection read', async () => {
    const { owner, code } = await setup();
    const beforePage = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const app = await createIntegrationApp(runtime, {
      authService: {
        ...runtime.authService,
        exportUserData: async (input) => {
          const result = await runtime.authService.exportUserData(input);
          return {
            ...result,
            following: {
              async *[Symbol.asyncIterator]() {
                beforePage.resolve();
                await release.promise;
                yield* result.following;
              },
            },
          };
        },
      },
    });
    const operation = startAction(app, 'export', owner.sessionKey).then(
      (response) => ({ response, error: null }),
      (error: unknown) => ({ response: null, error }),
    );
    const [outcome] = await coordinateWhilePaused({
      firstBarrierDescription: 'export headers sent before first page',
      firstOperation: operation,
      firstPaused: beforePage.promise,
      releaseFirst: release.resolve,
      runWhilePaused: () =>
        runtime.authService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD }),
      whilePausedDescription: 'reset commits without holding a streaming user lock',
    });
    expect(outcome.response?.status ?? null).toBeNull();
    expect(outcome.error).toMatchObject({ code: 'ECONNRESET' });
  });
});
