import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  EMAIL_NOT_VERIFIED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
} from '../../src/modules/auth/errors.js';
import { LOGIN_SUCCESS_MESSAGE } from '../../src/modules/auth/messages.js';
import { holdAuthTransaction } from './support/authTransactions.js';
import { coordinateLockInterleaving } from './support/asyncBarriers.js';
import { createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationApp,
  createIntegrationAuthService,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const EMAIL = 'login-race@example.com';
const USERNAME = 'login_race';
const NEXT_PASSWORD = 'ResetPassword2!';

describe('login transaction security integration', () => {
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

  test('rejects an old-password login waiting behind a password reset commit', async () => {
    const owner = await createVerifiedSession(runtime, { email: EMAIL, username: USERNAME });
    const before = await runtime.prisma.user.findUniqueOrThrow({
      where: { id: owner.userId },
      select: { lastLogin: true },
    });
    await runtime.authService.requestPasswordReset({ email: EMAIL });
    const code = runtime.delivered.passwordReset.at(-1)?.token;
    if (!code) throw new Error('Reset code was not delivered');

    const gate = holdAuthTransaction(runtime.prisma, 'before-commit');
    const resetService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const app = await createIntegrationApp(runtime);
    const [resetResult, loginResponse] = await coordinateLockInterleaving({
      firstBarrierDescription: 'reset SQL writes before commit',
      firstOperation: resetService.resetPassword({ email: EMAIL, code, password: NEXT_PASSWORD }),
      firstPaused: gate.paused,
      releaseFirst: gate.release,
      secondLockDescription: 'login user row lock behind reset',
      startSecond: () =>
        request(app)
          .post('/auth/login')
          .send({ emailOrUsername: USERNAME, password: INITIAL_PASSWORD })
          .then((response) => response),
      waitForSecondLock: (signal) =>
        waitForPostgresLockWaiters(runtime.prisma, {
          applicationNames: [runtime.postgresApplicationName],
          expectedCount: 1,
          queryFragments: ['FROM "users"', 'FOR UPDATE'],
          signal,
        }),
    });

    expect(resetResult.sessionsLoggedOut).toBe(1);
    expect(loginResponse.status).toBe(401);
    expect(loginResponse.body).toEqual({
      error: 'Unauthorized',
      message: INVALID_CREDENTIALS_MESSAGE,
    });
    const user = await runtime.prisma.user.findUniqueOrThrow({
      where: { id: owner.userId },
      select: { passwordHash: true, lastLogin: true },
    });
    expect(await bcrypt.compare(INITIAL_PASSWORD, user.passwordHash)).toBe(false);
    expect(await bcrypt.compare(NEXT_PASSWORD, user.passwordHash)).toBe(true);
    expect(user.lastLogin).toEqual(before.lastLogin);
    expect(await runtime.prisma.session.count({ where: { userId: owner.userId } })).toBe(1);
    expect(
      await runtime.prisma.session.count({ where: { userId: owner.userId, isActive: true } }),
    ).toBe(0);
    expect(await runtime.authService.validateSession(owner.sessionKey)).toBeNull();

    const newLogin = await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: USERNAME, password: NEXT_PASSWORD });
    expect(newLogin.status).toBe(200);
  });

  test('reset waits for a login before insertion and revokes its committed session', async () => {
    const owner = await createVerifiedSession(runtime, { email: EMAIL, username: USERNAME });
    await runtime.authService.requestPasswordReset({ email: EMAIL });
    const code = runtime.delivered.passwordReset.at(-1)?.token;
    if (!code) throw new Error('Reset code was not delivered');

    const gate = holdAuthTransaction(runtime.prisma, 'before-insert');
    const loginService = createIntegrationAuthService(
      gate.prisma,
      runtime.objectStorage,
      runtime.delivered,
      runtime.userMediaExternalResources,
    );
    const [loginResult, resetResult] = await coordinateLockInterleaving({
      firstBarrierDescription: 'locked login before its session INSERT',
      firstOperation: loginService.login({ emailOrUsername: USERNAME, password: INITIAL_PASSWORD }),
      firstPaused: gate.paused,
      releaseFirst: gate.release,
      secondLockDescription: 'reset user lock behind login',
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

    expect(resetResult.sessionsLoggedOut).toBe(2);
    expect(await runtime.prisma.session.count({ where: { userId: owner.userId } })).toBe(2);
    expect(
      await runtime.prisma.session.count({ where: { userId: owner.userId, isActive: true } }),
    ).toBe(0);
    expect(await runtime.authService.validateSession(owner.sessionKey)).toBeNull();
    expect(await runtime.authService.validateSession(loginResult.sessionKey)).toBeNull();
    const user = await runtime.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(await bcrypt.compare(NEXT_PASSWORD, user.passwordHash)).toBe(true);
  });

  test.each(['ban', 'delete', 'unverify', 'role'] as const)(
    'rereads the account after bcrypt when %s changes',
    async (change) => {
      const owner = await createVerifiedSession(runtime, { email: EMAIL, username: USERNAME });
      let changeApplied = false;
      const authService = createIntegrationAuthService(
        runtime.prisma,
        runtime.objectStorage,
        runtime.delivered,
        runtime.userMediaExternalResources,
        {
          afterPasswordCompare: async () => {
            if (changeApplied) return;
            changeApplied = true;
            if (change === 'ban') {
              const admin = await createVerifiedSession(runtime, {
                email: 'login-admin@example.com',
                username: 'login_admin',
              });
              await runtime.prisma.user.update({
                where: { id: admin.userId },
                data: { role: 'admin' },
              });
              await runtime.adminService.banAccount({
                actorUserId: admin.userId,
                targetUserId: owner.userId,
                reason: 'Integration test',
              });
            } else if (change === 'delete') {
              await runtime.authService.deleteAccount({
                userId: owner.userId,
                currentPassword: INITIAL_PASSWORD,
              });
            } else {
              await runtime.prisma.user.update({
                where: { id: owner.userId },
                data:
                  change === 'unverify'
                    ? { isVerified: false }
                    : { role: 'moderator', displayName: 'Current profile' },
              });
            }
          },
        },
      );
      const app = await createIntegrationApp(runtime, { authService });
      const response = await request(app)
        .post('/auth/login')
        .send({ emailOrUsername: USERNAME, password: INITIAL_PASSWORD });
      expect(changeApplied).toBe(true);
      if (change === 'role') {
        expect(response.status).toBe(200);
        const session = await runtime.prisma.session.findFirstOrThrow({
          where: { userId: owner.userId },
          orderBy: { createdAt: 'desc' },
        });
        expect(response.body).toEqual({
          message: LOGIN_SUCCESS_MESSAGE,
          user: {
            email: EMAIL,
            username: USERNAME,
            displayName: 'Current profile',
            bio: null,
            role: 'moderator',
          },
          sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
          session: { id: session.publicId, expiresAt: session.expiresAt.toISOString() },
        });
      } else {
        expect(response.status).toBe(change === 'delete' ? 401 : 403);
        expect(response.body).toEqual({
          error: change === 'delete' ? 'Unauthorized' : 'Forbidden',
          message:
            change === 'delete'
              ? INVALID_CREDENTIALS_MESSAGE
              : change === 'unverify'
                ? EMAIL_NOT_VERIFIED_MESSAGE
                : 'This account has been banned',
        });
        expect(await runtime.prisma.session.count({ where: { userId: owner.userId } })).toBe(
          change === 'delete' ? 0 : 1,
        );
      }
    },
  );
});
