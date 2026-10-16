import { describe, expect, test } from 'bun:test';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  sensitiveActionReauthenticationSchema,
} from '../src/modules/auth/http/schemas/index.js';
import { createAuthService } from '../src/modules/auth/index.js';
import {
  PasswordContainsNulError,
  PasswordTooLongError,
  PASSWORD_TOO_LONG_MESSAGE,
} from '../src/modules/auth/errors.js';
import { toAuthHttpError } from '../src/modules/auth/http/errorMapper.js';
import { HttpError, REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { createTestDeps } from './support/authService.js';
import { createStubAuthService } from './support/auth.js';
import { createStubAdminService } from './support/admin.js';
import { createStubCommentsService } from './support/comments.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideoUploadsService, createStubVideosService } from './support/videos.js';

const boundaryCases = [
  { name: '71 ASCII bytes', password: `A1!${'x'.repeat(68)}`, bytes: 71, accepted: true },
  { name: '72 ASCII bytes', password: `A1!${'x'.repeat(69)}`, bytes: 72, accepted: true },
  { name: '73 ASCII bytes', password: `A1!${'x'.repeat(70)}`, bytes: 73, accepted: false },
  { name: '72 accented bytes', password: `A1!x${'é'.repeat(34)}`, bytes: 72, accepted: true },
  { name: '74 accented bytes', password: `A1!x${'é'.repeat(35)}`, bytes: 74, accepted: false },
  { name: '72 emoji bytes', password: `A1!xx${'😀'.repeat(16)}xyz`, bytes: 72, accepted: true },
  { name: '76 emoji bytes', password: `A1!x${'😀'.repeat(18)}`, bytes: 76, accepted: false },
  {
    name: 'accent crossing byte 72',
    password: `A1!${'x'.repeat(68)}é`,
    bytes: 73,
    accepted: false,
  },
  {
    name: 'emoji crossing byte 72',
    password: `A1!${'x'.repeat(68)}😀`,
    bytes: 75,
    accepted: false,
  },
  {
    name: 'complexity only in ignored suffix',
    password: `${'a'.repeat(72)}A1!`,
    bytes: 75,
    accepted: false,
  },
];

const nulPasswords = [
  { name: 'periodic NUL secret', password: 'A1!\u0000A1!\u0000A1!' },
  { name: 'leading NUL', password: '\u0000Password1!' },
  { name: 'trailing NUL', password: 'Password1!\u0000' },
  { name: 'interior NUL', password: 'Pass\u0000word1!' },
  { name: 'NUL at byte 72', password: `A1!${'x'.repeat(68)}\u0000` },
];
const nulMessage = 'Password must not contain NUL (U+0000)';

const schemaCases = [
  {
    name: 'registration',
    parse: (password: string) =>
      registerSchema.safeParse({
        body: { email: 'user@example.com', username: 'fairplay_user', password },
      }),
  },
  {
    name: 'reset',
    parse: (password: string) =>
      resetPasswordSchema.safeParse({
        body: { email: 'user@example.com', code: '123456', password },
      }),
  },
  {
    name: 'login',
    parse: (password: string) =>
      loginSchema.safeParse({ body: { emailOrUsername: 'user@example.com', password } }),
  },
  {
    name: 'reauthentication',
    parse: (currentPassword: string) =>
      sensitiveActionReauthenticationSchema.safeParse({ body: { currentPassword } }),
  },
];

describe('UTF-8 password policy', () => {
  test('observes the real bcrypt NUL-period equivalence without assuming first-NUL truncation', async () => {
    const periodic = 'A1!\u0000A1!\u0000A1!';
    expect(Buffer.byteLength(periodic)).toBe(11);
    expect(bcrypt.truncates(periodic)).toBe(false);
    expect(await bcrypt.compare('A1!', await bcrypt.hash(periodic, 4))).toBe(true);
    expect(await bcrypt.compare('A1!', await bcrypt.hash('A1!\u0000different', 4))).toBe(false);
    expect(await bcrypt.compare('A1!', await bcrypt.hash('A1!A1!A1!', 4))).toBe(false);
  });

  for (const fixture of nulPasswords) {
    test(`rejects ${fixture.name} in all HTTP schemas without truncating or stripping NUL`, () => {
      expect(bcrypt.truncates(fixture.password)).toBe(false);
      for (const schema of schemaCases) {
        expect(schema.parse(fixture.password).success).toBe(false);
      }
    });
  }

  for (const fixture of boundaryCases) {
    test(fixture.name, () => {
      expect(Buffer.byteLength(fixture.password, 'utf8')).toBe(fixture.bytes);
      expect(bcrypt.truncates(fixture.password)).toBe(!fixture.accepted);
      for (const schema of schemaCases) {
        expect(schema.parse(fixture.password).success).toBe(fixture.accepted);
      }
    });
  }

  test('preserves whitespace and Unicode sequences verbatim', () => {
    const password = ' A1!e\u0301😀 ';
    const registration = registerSchema.parse({
      body: { email: 'user@example.com', username: 'fairplay_user', password },
    });
    const reset = resetPasswordSchema.parse({
      body: { email: 'user@example.com', code: '123456', password },
    });
    const login = loginSchema.parse({ body: { emailOrUsername: 'user@example.com', password } });
    const reauthentication = sensitiveActionReauthenticationSchema.parse({
      body: { currentPassword: password },
    });
    expect([
      registration.body.password,
      reset.body.password,
      login.body.password,
      reauthentication.body.currentPassword,
    ]).toEqual([password, password, password, password]);
  });

  test('accepts literal backslash-u0000 text, which contains no NUL', () => {
    for (const schema of schemaCases) {
      expect(schema.parse('A1!\\u0000A1!').success).toBe(true);
    }
  });

  test('keeps creation strength rules separate from authentication', () => {
    expect(
      registerSchema.safeParse({
        body: { email: 'user@example.com', username: 'fairplay_user', password: 'weak' },
      }).success,
    ).toBe(false);
    expect(
      resetPasswordSchema.safeParse({
        body: { email: 'user@example.com', code: '123456', password: 'weak' },
      }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ body: { emailOrUsername: 'user@example.com', password: 'weak' } })
        .success,
    ).toBe(true);
    expect(
      sensitiveActionReauthenticationSchema.safeParse({ body: { currentPassword: 'weak' } })
        .success,
    ).toBe(true);
  });

  test('maps direct-service length failures to a public bad request', () => {
    const error = toAuthHttpError(new PasswordTooLongError());
    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) throw new Error('Expected HTTP error');
    expect([error.statusCode, error.code, error.message]).toEqual([
      400,
      'BadRequest',
      PASSWORD_TOO_LONG_MESSAGE,
    ]);
  });

  test('maps direct-service NUL failures to a public bad request without echoing the secret', () => {
    const error = toAuthHttpError(new PasswordContainsNulError());
    if (!(error instanceof HttpError)) throw new Error('Expected HTTP error');
    expect([error.statusCode, error.code, error.message]).toEqual([400, 'BadRequest', nulMessage]);
  });

  for (const fixture of [
    {
      name: 'byte overflow',
      password: `A1!${'x'.repeat(68)}é`,
      message: PASSWORD_TOO_LONG_MESSAGE,
    },
    { name: 'NUL', password: 'A1!\u0000A1!\u0000A1!', message: nulMessage },
  ]) {
    test(`serializes uniform HTTP ${fixture.name} failures across all password endpoints`, async () => {
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
          authService: createStubAuthService(),
          adminService: createStubAdminService(),
          commentsService: createStubCommentsService(),
          profilesService: createStubProfilesService(),
          videosService: createStubVideosService(),
          videoUploadsService: createStubVideoUploadsService(),
        },
      );
      const password = fixture.password;
      const passwordError = {
        error: 'ValidationError',
        message: REQUEST_VALIDATION_FAILED_MESSAGE,
        details: [{ field: 'body.password', message: fixture.message }],
      };
      await request(app)
        .post('/auth/register')
        .send({ email: 'user@example.com', username: 'fairplay_user', password })
        .expect(400)
        .expect(passwordError);
      for (const emailOrUsername of ['user@example.com', 'missing@example.com']) {
        await request(app)
          .post('/auth/login')
          .send({ emailOrUsername, password })
          .expect(400)
          .expect(passwordError);
      }
      await request(app)
        .post('/auth/reset-password')
        .send({ email: 'user@example.com', code: '123456', password })
        .expect(400)
        .expect(passwordError);
      for (const pending of [
        request(app).post('/auth/me/export'),
        request(app).delete('/auth/me'),
        request(app).delete('/auth/sessions/all'),
        request(app).delete('/auth/sessions/others/all'),
      ]) {
        await pending
          .set('Authorization', 'Bearer test-session-key')
          .send({ currentPassword: password })
          .expect(400)
          .expect({
            ...passwordError,
            details: [{ field: 'body.currentPassword', message: fixture.message }],
          });
      }
    });
  }

  for (const fixture of [
    ...boundaryCases
      .filter(({ accepted }) => !accepted)
      .map((fixture) => ({ ...fixture, errorName: 'PasswordTooLongError' })),
    ...nulPasswords.map((fixture) => ({ ...fixture, errorName: 'PasswordContainsNulError' })),
  ]) {
    test(`rejects ${fixture.name} at every service entry before account lookup or effects`, async () => {
      const hashed: string[] = [];
      const compared: string[] = [];
      const { deps, calls } = createTestDeps({
        hasher: {
          hash: async (password) => {
            hashed.push(password);
            return bcrypt.hash(password, 4);
          },
          compare: async (password, hash) => {
            compared.push(password);
            return bcrypt.compare(password, hash);
          },
        },
      });
      const service = createAuthService(deps);
      const password = fixture.password;
      const operations = [
        () => service.register({ email: 'user@example.com', username: 'fairplay_user', password }),
        () => service.resetPassword({ email: 'user@example.com', code: '123456', password }),
        () => service.login({ emailOrUsername: 'user@example.com', password }),
        () => service.deleteAccount({ userId: 'user-id', currentPassword: password }),
        () =>
          service.exportUserData({
            userId: 'user-id',
            currentSessionId: 'session-id',
            currentPassword: password,
          }),
        () => service.logoutAllSessions({ userId: 'user-id', currentPassword: password }),
        () =>
          service.logoutOtherSessions({
            userId: 'user-id',
            currentSessionId: 'session-id',
            currentPassword: password,
          }),
      ];
      for (const run of operations) {
        await expect(run()).rejects.toMatchObject({ name: fixture.errorName });
      }
      expect(hashed).not.toContain(password);
      expect(compared).toEqual([]);
      for (const call of [
        calls.userFindFirst,
        calls.userFindUnique,
        calls.userCreate,
        calls.userUpdateMany,
        calls.userDeleteMany,
        calls.sessionCreate,
        calls.sessionUpdateMany,
        calls.passwordResetTokenFindUnique,
        calls.passwordResetTokenDeleteMany,
        calls.tokenCreate,
        calls.sentEmail,
      ]) {
        expect(call).toBeUndefined();
      }
    });
  }
});
