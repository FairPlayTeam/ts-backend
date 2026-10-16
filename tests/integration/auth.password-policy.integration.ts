import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../../src/errors/http.js';
import {
  INVALID_CREDENTIALS_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
} from '../../src/modules/auth/errors.js';
import { LOGIN_SUCCESS_MESSAGE } from '../../src/modules/auth/messages.js';
import { createVerifiedSession } from './support/fixtures.js';
import {
  createIntegrationApp,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const invalidPasswordBody = (
  field: 'password' | 'currentPassword',
  message = PASSWORD_TOO_LONG_MESSAGE,
) => ({
  error: 'ValidationError',
  message: REQUEST_VALIDATION_FAILED_MESSAGE,
  details: [{ field: `body.${field}`, message }],
});
const nulPassword = 'A1!\u0000A1!\u0000A1!';
const nulMessage = 'Password must not contain NUL (U+0000)';

describe('password byte policy through HTTP and real bcrypt', () => {
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

  test.each(['registration', 'reset'])(
    'prevents the short periodic alias through %s on an initially empty database',
    async (source) => {
      const app = await createIntegrationApp(runtime);
      const email = 'nul-policy@example.com';
      const username = 'nul_policy';
      let password = 'A1!A1!A1!';
      expect(await runtime.prisma.user.count()).toBe(0);
      expect(await bcrypt.compare('A1!', await bcrypt.hash(nulPassword, 4))).toBe(true);
      if (source === 'registration') {
        await request(app)
          .post('/auth/register')
          .send({ email, username, password: nulPassword })
          .expect(400)
          .expect(invalidPasswordBody('password', nulMessage));
        expect(await runtime.prisma.user.count()).toBe(0);
        expect(await runtime.prisma.emailVerificationToken.count()).toBe(0);
        expect(await runtime.prisma.passwordResetToken.count()).toBe(0);
        expect(await runtime.prisma.session.count()).toBe(0);
        expect(runtime.delivered.verification).toEqual([]);
        expect(runtime.delivered.passwordReset).toEqual([]);
      }
      await request(app).post('/auth/register').send({ email, username, password }).expect(201);
      await request(app)
        .post('/auth/verify-email')
        .send({ email, code: runtime.delivered.verification.at(-1)?.token })
        .expect(200);
      if (source === 'reset') {
        await request(app).post('/auth/forgot-password').send({ email }).expect(200);
        const userBefore = await runtime.prisma.user.findUniqueOrThrow({ where: { email } });
        const tokenBefore = await runtime.prisma.passwordResetToken.findUniqueOrThrow({
          where: { userId: userBefore.id },
        });
        const sessionsBefore = await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } });
        const mailBefore = {
          verification: [...runtime.delivered.verification],
          reset: [...runtime.delivered.passwordReset],
        };
        const code = runtime.delivered.passwordReset.at(-1)?.token;
        await request(app)
          .post('/auth/reset-password')
          .send({ email, code, password: nulPassword })
          .expect(400)
          .expect(invalidPasswordBody('password', nulMessage));
        expect(await runtime.prisma.user.findUniqueOrThrow({ where: { email } })).toEqual(
          userBefore,
        );
        expect(
          await runtime.prisma.passwordResetToken.findUniqueOrThrow({
            where: { userId: userBefore.id },
          }),
        ).toEqual(tokenBefore);
        expect(await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } })).toEqual(
          sessionsBefore,
        );
        expect(runtime.delivered.verification).toEqual(mailBefore.verification);
        expect(runtime.delivered.passwordReset).toEqual(mailBefore.reset);
        password = 'A1!A1!A1!A1!';
        await request(app).post('/auth/reset-password').send({ email, code, password }).expect(200);
        expect(await runtime.prisma.passwordResetToken.count()).toBe(0);
        expect(await runtime.prisma.session.count({ where: { isActive: true } })).toBe(0);
      }
      const stored = await runtime.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await bcrypt.compare(password, stored.passwordHash)).toBe(true);
      expect(await bcrypt.compare('A1!', stored.passwordHash)).toBe(false);
      const invalidCredentialsBody = {
        error: 'Unauthorized',
        message: INVALID_CREDENTIALS_MESSAGE,
      };
      await request(app)
        .post('/auth/login')
        .send({ emailOrUsername: email, password: 'A1!' })
        .expect(401)
        .expect(invalidCredentialsBody);
      const login = await request(app)
        .post('/auth/login')
        .send({ emailOrUsername: email, password })
        .expect(200);
      expect(login.body).toEqual({
        message: LOGIN_SUCCESS_MESSAGE,
        user: { email, username, displayName: username, bio: null, role: 'user' },
        sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        session: { id: expect.any(String), expiresAt: expect.any(String) },
      });
      const sessionKey: unknown = login.body.sessionKey;
      if (typeof sessionKey !== 'string') throw new Error('Expected session key');
      const userBeforeReauthentication = await runtime.prisma.user.findUniqueOrThrow({
        where: { email },
      });
      const sessionsBefore = await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } });
      for (const pending of [
        request(app).post('/auth/me/export'),
        request(app).delete('/auth/sessions/all'),
        request(app).delete('/auth/sessions/others/all'),
        request(app).delete('/auth/me'),
      ]) {
        await pending
          .set('Authorization', `Bearer ${sessionKey}`)
          .send({ currentPassword: 'A1!' })
          .expect(401)
          .expect(invalidCredentialsBody);
      }
      expect(await runtime.prisma.user.findUniqueOrThrow({ where: { email } })).toEqual(
        userBeforeReauthentication,
      );
      const sessionsAfter = await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } });
      expect(sessionsAfter.map(({ id, isActive }) => ({ id, isActive }))).toEqual(
        sessionsBefore.map(({ id, isActive }) => ({ id, isActive })),
      );
    },
  );

  test('rejects NUL on login and all reauthentication routes while preserving legacy recovery', async () => {
    const app = await createIntegrationApp(runtime);
    const email = 'legacy-nul@example.com';
    const { userId, sessionKey } = await createVerifiedSession(runtime, {
      email,
      username: 'legacy_nul',
    });
    // Only the fixture bypasses the new policy to represent a pre-policy bcrypt hash.
    await runtime.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(nulPassword, 4) },
    });
    for (const emailOrUsername of [email, 'missing@example.com']) {
      await request(app)
        .post('/auth/login')
        .send({ emailOrUsername, password: nulPassword })
        .expect(400)
        .expect(invalidPasswordBody('password', nulMessage));
    }
    for (const pending of [
      request(app).post('/auth/me/export'),
      request(app).delete('/auth/sessions/all'),
      request(app).delete('/auth/sessions/others/all'),
      request(app).delete('/auth/me'),
    ]) {
      await pending
        .set('Authorization', `Bearer ${sessionKey}`)
        .send({ currentPassword: nulPassword })
        .expect(400)
        .expect(invalidPasswordBody('currentPassword', nulMessage));
    }
    // Rejecting NUL cannot identify or repair a legacy hash's NUL-free short alias.
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: 'A1!' })
      .expect(200);
    await request(app).post('/auth/forgot-password').send({ email }).expect(200);
    await request(app)
      .post('/auth/reset-password')
      .send({
        email,
        code: runtime.delivered.passwordReset.at(-1)?.token,
        password: 'Replacement1!',
      })
      .expect(200);
    expect(await runtime.prisma.session.count({ where: { isActive: true } })).toBe(0);
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: 'A1!' })
      .expect(401);
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: 'Replacement1!' })
      .expect(200);
  });

  test.each([
    { name: 'ASCII', password: `A1!${'x'.repeat(69)}` },
    { name: 'accents', password: `A1!x${'é'.repeat(34)}` },
    { name: 'emojis', password: `A1!xx${'😀'.repeat(16)}xyz` },
  ])(
    'uses all 72 bytes for $name across registration, login, reauthentication and reset',
    async ({ password }) => {
      expect(Buffer.byteLength(password)).toBe(72);
      const app = await createIntegrationApp(runtime);
      const email = 'byte-policy@example.com';
      const username = 'byte_policy';
      await request(app).post('/auth/register').send({ email, username, password }).expect(201);
      const registered = await runtime.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await bcrypt.compare(password, registered.passwordHash)).toBe(true);
      expect(await bcrypt.compare(password.slice(0, -1), registered.passwordHash)).toBe(false);
      const verification = runtime.delivered.verification.at(-1);
      await request(app)
        .post('/auth/verify-email')
        .send({ email, code: verification?.token })
        .expect(200);

      const login = await request(app)
        .post('/auth/login')
        .send({ emailOrUsername: email, password })
        .expect(200);
      expect(login.body).toEqual({
        message: LOGIN_SUCCESS_MESSAGE,
        user: { email, username, displayName: username, bio: null, role: 'user' },
        sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        session: { id: expect.any(String), expiresAt: expect.any(String) },
      });
      const sessionKey: unknown = login.body.sessionKey;
      if (typeof sessionKey !== 'string') throw new Error('Expected session key');
      const session = await runtime.prisma.session.findUniqueOrThrow({
        where: { publicId: login.body.session.id },
      });
      expect(login.body.session.id).not.toBe(session.id);
      await request(app)
        .delete('/auth/sessions/others/all')
        .set('Authorization', `Bearer ${sessionKey}`)
        .send({ currentPassword: password })
        .expect(200);

      await request(app).post('/auth/forgot-password').send({ email }).expect(200);
      const resetCode = runtime.delivered.passwordReset.at(-1)?.token;
      const nextPassword = `B${password.slice(1)}`;
      await request(app)
        .post('/auth/reset-password')
        .send({ email, code: resetCode, password: nextPassword })
        .expect(200);
      const resetUser = await runtime.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await bcrypt.compare(nextPassword, resetUser.passwordHash)).toBe(true);
      expect(await bcrypt.compare(password, resetUser.passwordHash)).toBe(false);
      expect(await runtime.prisma.passwordResetToken.count()).toBe(0);
      expect(await runtime.prisma.session.count({ where: { isActive: true } })).toBe(0);
      await request(app)
        .post('/auth/login')
        .send({ emailOrUsername: email, password: nextPassword })
        .expect(200);
    },
  );

  test('rejects suffix variants on every HTTP entry without consuming a valid reset or mutating the account', async () => {
    const app = await createIntegrationApp(runtime);
    const email = 'byte-policy@example.com';
    const { sessionKey, userId } = await createVerifiedSession(runtime, {
      email,
      username: 'byte_policy',
    });
    const password = `A1!${'x'.repeat(69)}`;
    const passwordHash = await bcrypt.hash(password, 4);
    await runtime.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await request(app).post('/auth/forgot-password').send({ email }).expect(200);
    const tokenBefore = await runtime.prisma.passwordResetToken.findUniqueOrThrow({
      where: { userId },
    });
    const sessionsBefore = await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } });
    const userBefore = await runtime.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const oversized = `${password}different-suffix`;
    expect(await bcrypt.compare(oversized, passwordHash)).toBe(true);

    await request(app)
      .post('/auth/register')
      .send({ email: 'new@example.com', username: 'new_byte_user', password: oversized })
      .expect(400)
      .expect(invalidPasswordBody('password'));
    for (const emailOrUsername of [email, 'missing@example.com']) {
      await request(app)
        .post('/auth/login')
        .send({ emailOrUsername, password: oversized })
        .expect(400)
        .expect(invalidPasswordBody('password'));
      await request(app)
        .post('/auth/login')
        .send({ emailOrUsername, password: 'WrongPassword1!' })
        .expect(401)
        .expect({ error: 'Unauthorized', message: INVALID_CREDENTIALS_MESSAGE });
    }
    await request(app)
      .post('/auth/reset-password')
      .send({ email, code: runtime.delivered.passwordReset.at(-1)?.token, password: oversized })
      .expect(400)
      .expect(invalidPasswordBody('password'));
    const sensitiveRequests = [
      request(app).post('/auth/me/export'),
      request(app).delete('/auth/me'),
      request(app).delete('/auth/sessions/all'),
      request(app).delete('/auth/sessions/others/all'),
    ];
    for (const pending of sensitiveRequests) {
      await pending
        .set('Authorization', `Bearer ${sessionKey}`)
        .send({ currentPassword: oversized })
        .expect(400)
        .expect(invalidPasswordBody('currentPassword'));
    }
    expect(await runtime.prisma.user.count()).toBe(1);
    expect(await runtime.prisma.user.findUniqueOrThrow({ where: { id: userId } })).toEqual(
      userBefore,
    );
    expect(
      await runtime.prisma.passwordResetToken.findUniqueOrThrow({ where: { userId } }),
    ).toEqual(tokenBefore);
    // Session authentication may touch lastUsedAt; the rejected actions must preserve session eligibility.
    const sessionsAfter = await runtime.prisma.session.findMany({ orderBy: { id: 'asc' } });
    expect(sessionsAfter.map(({ id, isActive }) => ({ id, isActive }))).toEqual(
      sessionsBefore.map(({ id, isActive }) => ({ id, isActive })),
    );
    await request(app)
      .post('/auth/reset-password')
      .send({
        email,
        code: runtime.delivered.passwordReset.at(-1)?.token,
        password: 'Replacement1!',
      })
      .expect(200);
    expect(await runtime.prisma.session.count({ where: { isActive: true } })).toBe(0);
  });

  test('requires recovery for legacy long inputs and documents that their valid 72-byte prefix still matches', async () => {
    const app = await createIntegrationApp(runtime);
    const email = 'legacy@example.com';
    const { userId } = await createVerifiedSession(runtime, { email, username: 'legacy_user' });
    const prefix = 'a'.repeat(72);
    const legacyPassword = `${prefix}A1!`;
    await runtime.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(legacyPassword, 4) },
    });
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: legacyPassword })
      .expect(400)
      .expect(invalidPasswordBody('password'));
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: prefix })
      .expect(200);
    await request(app).post('/auth/forgot-password').send({ email }).expect(200);
    await request(app)
      .post('/auth/reset-password')
      .send({
        email,
        code: runtime.delivered.passwordReset.at(-1)?.token,
        password: 'Replacement1!',
      })
      .expect(200);
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: prefix })
      .expect(401);
    await request(app)
      .post('/auth/login')
      .send({ emailOrUsername: email, password: 'Replacement1!' })
      .expect(200);
  });
});
