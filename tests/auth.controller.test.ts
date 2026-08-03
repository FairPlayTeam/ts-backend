import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { createAuthController } from '../src/controllers/auth.controller.js';
import type { AuthenticatedRequest } from '../src/middleware/auth.js';
import type {
  LoginRequestBody,
  RegisterRequestBody,
  RequestPasswordResetRequestBody,
  ResendVerificationRequestBody,
  ResetPasswordRequestBody,
  UpdateProfileRequestBody,
  UserSessionsQuery,
  VerifyEmailRequestBody,
} from '../src/controllers/auth.schemas.js';
import { HttpError } from '../src/errors/http.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';
import {
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import type { AuthControllerPort } from '../src/services/auth.types.js';

const registerBody: RegisterRequestBody = {
  email: 'user@example.com',
  username: 'fairplay_user',
  password: 'Password1!',
};

const resendVerificationBody: ResendVerificationRequestBody = {
  email: 'user@example.com',
};

const requestPasswordResetBody: RequestPasswordResetRequestBody = {
  email: 'user@example.com',
};

const resetPasswordBody: ResetPasswordRequestBody = {
  email: 'user@example.com',
  code: '123456',
  password: 'NewPassword1!',
};

const loginBody: LoginRequestBody = {
  emailOrUsername: 'user@example.com',
  password: 'Password1!',
};

const verifyEmailBody: VerifyEmailRequestBody = {
  email: 'user@example.com',
  code: '123456',
};

const sensitiveActionBody = {
  currentPassword: 'Password1!',
};

const loginResult = {
  message: LOGIN_SUCCESS_MESSAGE,
  user: {
    id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    email: 'user@example.com',
    username: 'fairplay_user',
    displayName: 'FairPlay User',
    bio: 'Definitely not an undercover Y**tube employee.',
    role: 'user' as const,
  },
  sessionKey: 'plain-session-key',
  session: {
    id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
  },
};

const verifyEmailResult = {
  ...loginResult,
  message: VERIFY_EMAIL_SUCCESS_MESSAGE,
};

const validatedSession = {
  user: loginResult.user,
  session: loginResult.session,
};

const userSessionsResult = {
  sessions: [
    {
      id: loginResult.session.id,
      sessionKeySuffix: 'sion-key',
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
      deviceInfo: 'bun-test',
      isCurrent: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: loginResult.session.expiresAt,
    },
  ],
  nextCursor: {
    lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
    id: loginResult.session.id,
  },
  total: 1,
};

const userDataExportResult = {
  exportedAt: new Date('2026-01-01T00:00:00.000Z'),
  user: {
    ...loginResult.user,
    isVerified: true,
    isBanned: false,
    bannedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastLogin: new Date('2026-01-01T00:00:00.000Z'),
  },
  mediaAssets: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'avatar' as const,
      url: '/profiles/fairplay_user/avatar',
      mimeType: 'image/webp',
      sizeBytes: 1234,
      width: 512,
      height: 512,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'banner' as const,
      url: '/profiles/fairplay_user/banner',
      mimeType: 'image/webp',
      sizeBytes: 2345,
      width: 1500,
      height: 500,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ],
  videoRatings: [
    {
      videoId: '33333333-3333-4333-8333-333333333333',
      value: 5,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ],
  sessions: [
    {
      id: loginResult.session.id,
      sessionKeySuffix: 'sion-key',
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
      deviceInfo: 'bun-test',
      isActive: true,
      isCurrent: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: loginResult.session.expiresAt,
    },
  ],
  emailVerificationToken: null,
  passwordResetToken: null,
};

type ControllerAuthService = AuthControllerPort;

const createControllerAuthService = (
  overrides: Partial<ControllerAuthService> = {},
): ControllerAuthService => ({
  register: async () => ({ message: REGISTER_SUCCESS_MESSAGE }),
  login: async () => loginResult,
  verifyEmail: async () => verifyEmailResult,
  resendVerification: async () => ({ message: RESEND_VERIFICATION_EMAIL_MESSAGE }),
  getProfile: async () => ({
    user: {
      ...loginResult.user,
      avatarUrl: '/profiles/fairplay_user/avatar',
      bannerUrl: '/profiles/fairplay_user/banner',
    },
  }),
  getUserSessions: async () => userSessionsResult,
  logoutAllSessions: async () => ({
    message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  logoutOtherSessions: async () => ({
    message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  logoutSession: async () => ({
    message: LOGOUT_SESSION_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  updateProfile: async () => ({
    message: UPDATE_PROFILE_SUCCESS_MESSAGE,
    user: loginResult.user,
  }),
  uploadAvatar: async () => ({
    message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
    avatar: {
      url: '/profiles/fairplay_user/avatar',
      mimeType: 'image/webp',
      sizeBytes: 1234,
      width: 512,
      height: 512,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  }),
  deleteAvatar: async () => ({
    message: DELETE_AVATAR_SUCCESS_MESSAGE,
    avatar: null,
  }),
  uploadBanner: async () => ({
    message: UPLOAD_BANNER_SUCCESS_MESSAGE,
    banner: {
      url: '/profiles/fairplay_user/banner',
      mimeType: 'image/webp',
      sizeBytes: 2345,
      width: 1500,
      height: 500,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  }),
  deleteBanner: async () => ({
    message: DELETE_BANNER_SUCCESS_MESSAGE,
    banner: null,
  }),
  requestPasswordReset: async () => ({ message: RESET_PASSWORD_EMAIL_MESSAGE }),
  resetPassword: async () => ({
    message: RESET_PASSWORD_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
  }),
  exportUserData: async () => userDataExportResult,
  deleteAccount: async () => ({
    message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
    mediaCleanupQueued: 0,
    externalCleanupQueued: 0,
  }),
  ...overrides,
});

const createTestAuthController = (overrides?: Partial<ControllerAuthService>) =>
  createAuthController({
    authService: createControllerAuthService(overrides),
  });

const createMockResponse = () => {
  const state: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
    contentType?: string;
  } = {
    headers: {},
  };

  const response = {
    set(name: string, value: string) {
      state.headers[name] = value;
      return response;
    },
    type(contentType: string) {
      state.contentType = contentType;
      return response;
    },
    status(statusCode: number) {
      state.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
    send(body: unknown) {
      state.body = body;
      return response;
    },
  } as unknown as Response;

  return { response, state };
};

type MockResponseState = ReturnType<typeof createMockResponse>['state'];

const expectNoStore = (state: MockResponseState) => {
  expect(state.headers['Cache-Control']).toBe('no-store');
};

describe('auth controller', () => {
  test('registers a user through the injected auth service', async () => {
    let receivedInput: RegisterRequestBody | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      register: async (input) => {
        receivedInput = input;
        return { message: REGISTER_SUCCESS_MESSAGE };
      },
    });

    await controller.register(
      { body: registerBody } as Request<unknown, unknown, RegisterRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual(registerBody);
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(201);
    expect(state.body).toEqual({
      message: REGISTER_SUCCESS_MESSAGE,
    });
  });

  test('maps known auth service errors before passing them to next', async () => {
    let receivedError: unknown;
    const { response } = createMockResponse();
    const controller = createTestAuthController({
      register: async () => {
        throw new UserAlreadyExistsError();
      },
    });

    await controller.register(
      { body: registerBody } as Request<unknown, unknown, RegisterRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedError).toBeInstanceOf(HttpError);
    expect((receivedError as HttpError).statusCode).toBe(409);
    expect((receivedError as HttpError).code).toBe('Conflict');
  });

  test('resends verification through the injected auth service', async () => {
    let receivedInput: ResendVerificationRequestBody | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      resendVerification: async (input) => {
        receivedInput = input;
        return { message: RESEND_VERIFICATION_EMAIL_MESSAGE };
      },
    });

    await controller.resendVerification(
      { body: resendVerificationBody } as Request<unknown, unknown, ResendVerificationRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual(resendVerificationBody);
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: RESEND_VERIFICATION_EMAIL_MESSAGE,
    });
  });

  test('requests password reset through the injected auth service', async () => {
    let receivedInput: RequestPasswordResetRequestBody | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      requestPasswordReset: async (input) => {
        receivedInput = input;
        return { message: RESET_PASSWORD_EMAIL_MESSAGE };
      },
    });

    await controller.requestPasswordReset(
      { body: requestPasswordResetBody } as Request<
        unknown,
        unknown,
        RequestPasswordResetRequestBody
      >,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual(requestPasswordResetBody);
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: RESET_PASSWORD_EMAIL_MESSAGE,
    });
  });

  test('resets password through the injected auth service', async () => {
    let receivedInput: ResetPasswordRequestBody | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      resetPassword: async (input) => {
        receivedInput = input;
        return {
          message: RESET_PASSWORD_SUCCESS_MESSAGE,
          sessionsLoggedOut: 2,
        };
      },
    });

    await controller.resetPassword(
      { body: resetPasswordBody } as Request<unknown, unknown, ResetPasswordRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual(resetPasswordBody);
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: RESET_PASSWORD_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });
    expectNoStore(state);
  });

  test('logs in through the injected auth service', async () => {
    let receivedInput:
      | (LoginRequestBody & { ipAddress?: string | undefined; userAgent?: string | undefined })
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      login: async (input) => {
        receivedInput = input;
        return loginResult;
      },
    });

    await controller.login(
      {
        body: loginBody,
        ip: '127.0.0.1',
        get: (name: string) => (name === 'user-agent' ? 'bun-test' : undefined),
      } as Request<unknown, unknown, LoginRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      ...loginBody,
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      ...loginResult,
      session: {
        id: loginResult.session.id,
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
    expectNoStore(state);
  });

  test('verifies email through the injected auth service', async () => {
    let receivedInput:
      | (VerifyEmailRequestBody & {
          ipAddress?: string | undefined;
          userAgent?: string | undefined;
        })
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      verifyEmail: async (input) => {
        receivedInput = input;
        return verifyEmailResult;
      },
    });

    await controller.verifyEmail(
      {
        body: verifyEmailBody,
        ip: '127.0.0.1',
        get: (name: string) => (name === 'user-agent' ? 'bun-test' : undefined),
      } as Request<unknown, unknown, VerifyEmailRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      ...verifyEmailBody,
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      ...verifyEmailResult,
      session: {
        id: verifyEmailResult.session.id,
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
    expectNoStore(state);
  });

  test('returns the authenticated user profile from the auth service', async () => {
    let receivedInput: { userId: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const profileUser = {
      ...validatedSession.user,
      avatarUrl: '/profiles/fairplay_user/avatar',
      bannerUrl: '/profiles/fairplay_user/banner',
    };
    const controller = createTestAuthController({
      getProfile: async (input) => {
        receivedInput = input;

        return {
          user: profileUser,
        };
      },
    });

    await controller.me(
      {
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      user: profileUser,
      session: {
        id: validatedSession.session.id,
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
    expectNoStore(state);
  });

  test('exports authenticated user data as downloadable JSON', async () => {
    let receivedInput:
      | { userId: string; currentSessionId: string; currentPassword: string }
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      exportUserData: async (input) => {
        receivedInput = input;

        return {
          ...userDataExportResult,
          emailVerificationToken: {
            id: 'verification-token-id',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: new Date('2026-01-08T00:00:00.000Z'),
          },
          passwordResetToken: {
            id: 'password-reset-token-id',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            expiresAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        };
      },
    });

    await controller.exportMe(
      {
        user: validatedSession.user,
        session: validatedSession.session,
        body: sensitiveActionBody,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentSessionId: validatedSession.session.id,
      currentPassword: 'Password1!',
    });
    expect(receivedError).toBeUndefined();
    expect(state.headers['Content-Disposition']).toBe(
      'attachment; filename="fairplay-user-data-export.json"',
    );
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(state.contentType).toBe('application/json');
    expect(state.statusCode).toBe(200);
    expect(typeof state.body).toBe('string');
    expect(state.body).toContain('\n  "exportedAt": "2026-01-01T00:00:00.000Z"');
    expect((state.body as string).endsWith('\n')).toBe(true);
    expect(JSON.parse(state.body as string)).toEqual({
      exportedAt: '2026-01-01T00:00:00.000Z',
      user: {
        ...loginResult.user,
        isVerified: true,
        isBanned: false,
        bannedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastLogin: '2026-01-01T00:00:00.000Z',
      },
      mediaAssets: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'avatar',
          url: '/profiles/fairplay_user/avatar',
          mimeType: 'image/webp',
          sizeBytes: 1234,
          width: 512,
          height: 512,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'banner',
          url: '/profiles/fairplay_user/banner',
          mimeType: 'image/webp',
          sizeBytes: 2345,
          width: 1500,
          height: 500,
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
      sessions: [
        {
          id: loginResult.session.id,
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
      emailVerificationToken: {
        id: 'verification-token-id',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      },
      passwordResetToken: {
        id: 'password-reset-token-id',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      },
    });
  });

  test('deletes the authenticated user account through the injected auth service', async () => {
    let receivedInput: { userId: string; currentPassword: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      deleteAccount: async (input) => {
        receivedInput = input;

        return {
          message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
          mediaCleanupQueued: 0,
          externalCleanupQueued: 0,
        };
      },
    });

    await controller.deleteMe(
      {
        user: validatedSession.user,
        session: validatedSession.session,
        body: sensitiveActionBody,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentPassword: 'Password1!',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
      mediaCleanupQueued: 0,
      externalCleanupQueued: 0,
    });
    expectNoStore(state);
  });

  test('updates the authenticated user profile through the injected auth service', async () => {
    let receivedInput:
      | (UpdateProfileRequestBody & {
          userId: string;
        })
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const updatedUser = {
      ...loginResult.user,
      displayName: 'Updated Name',
      bio: null,
    };
    const controller = createTestAuthController({
      updateProfile: async (input) => {
        receivedInput = input;
        return {
          message: UPDATE_PROFILE_SUCCESS_MESSAGE,
          user: updatedUser,
        };
      },
    });

    await controller.updateMe(
      {
        body: {
          displayName: 'Updated Name',
          bio: null,
        },
        user: validatedSession.user,
        session: validatedSession.session,
      } as unknown as AuthenticatedRequest & Request<unknown, unknown, UpdateProfileRequestBody>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      displayName: 'Updated Name',
      bio: null,
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: UPDATE_PROFILE_SUCCESS_MESSAGE,
      user: updatedUser,
    });
    expectNoStore(state);
  });

  test('uploads an authenticated user avatar through the injected auth service', async () => {
    let receivedInput:
      | {
          userId: string;
          file: {
            buffer: Buffer;
            size: number;
          };
        }
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const fileBuffer = Buffer.from('raw-avatar');
    const controller = createTestAuthController({
      uploadAvatar: async (input) => {
        receivedInput = input;

        return {
          message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
          avatar: {
            url: '/profiles/fairplay_user/avatar',
            mimeType: 'image/webp',
            sizeBytes: 1234,
            width: 512,
            height: 512,
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        };
      },
    });

    await controller.uploadAvatar(
      {
        file: {
          buffer: fileBuffer,
          size: fileBuffer.length,
        },
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      file: {
        buffer: fileBuffer,
        size: fileBuffer.length,
      },
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: '/profiles/fairplay_user/avatar',
        mimeType: 'image/webp',
        sizeBytes: 1234,
        width: 512,
        height: 512,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expectNoStore(state);
  });

  test('deletes an authenticated user avatar through the injected auth service', async () => {
    let receivedInput: { userId: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      deleteAvatar: async (input) => {
        receivedInput = input;

        return {
          message: DELETE_AVATAR_SUCCESS_MESSAGE,
          avatar: null,
        };
      },
    });

    await controller.deleteAvatar(
      {
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: DELETE_AVATAR_SUCCESS_MESSAGE,
      avatar: null,
    });
    expectNoStore(state);
  });

  test('uploads an authenticated user banner through the injected auth service', async () => {
    let receivedInput:
      | {
          userId: string;
          file: {
            buffer: Buffer;
            size: number;
          };
        }
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const fileBuffer = Buffer.from('raw-banner');
    const controller = createTestAuthController({
      uploadBanner: async (input) => {
        receivedInput = input;

        return {
          message: UPLOAD_BANNER_SUCCESS_MESSAGE,
          banner: {
            url: '/profiles/fairplay_user/banner',
            mimeType: 'image/webp',
            sizeBytes: 2345,
            width: 1500,
            height: 500,
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        };
      },
    });

    await controller.uploadBanner(
      {
        file: {
          buffer: fileBuffer,
          size: fileBuffer.length,
        },
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      file: {
        buffer: fileBuffer,
        size: fileBuffer.length,
      },
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: UPLOAD_BANNER_SUCCESS_MESSAGE,
      banner: {
        url: '/profiles/fairplay_user/banner',
        mimeType: 'image/webp',
        sizeBytes: 2345,
        width: 1500,
        height: 500,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expectNoStore(state);
  });

  test('deletes an authenticated user banner through the injected auth service', async () => {
    let receivedInput: { userId: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      deleteBanner: async (input) => {
        receivedInput = input;

        return {
          message: DELETE_BANNER_SUCCESS_MESSAGE,
          banner: null,
        };
      },
    });

    await controller.deleteBanner(
      {
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: DELETE_BANNER_SUCCESS_MESSAGE,
      banner: null,
    });
    expectNoStore(state);
  });

  test('returns active sessions for the authenticated user', async () => {
    let receivedInput:
      | {
          userId: string;
          currentSessionId: string;
          limit?: number;
          cursor?: { lastUsedAt: Date; id: string };
        }
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      getUserSessions: async (input) => {
        receivedInput = input;
        return userSessionsResult;
      },
    });

    await controller.sessions(
      {
        user: validatedSession.user,
        session: validatedSession.session,
        query: {
          limit: 10,
          cursorLastUsedAt: '2026-01-01T00:00:00.000Z',
          cursorId: loginResult.session.id,
        },
      } as AuthenticatedRequest & Request<unknown, unknown, unknown, UserSessionsQuery>,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentSessionId: validatedSession.session.id,
      limit: 10,
      cursor: {
        lastUsedAt: new Date('2026-01-01T00:00:00.000Z'),
        id: loginResult.session.id,
      },
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      sessions: [
        {
          id: loginResult.session.id,
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
      total: 1,
      nextCursor: {
        lastUsedAt: '2026-01-01T00:00:00.000Z',
        id: loginResult.session.id,
      },
    });
    expectNoStore(state);
  });

  test('logs out all sessions for the authenticated user', async () => {
    let receivedInput: { userId: string; currentPassword: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      logoutAllSessions: async (input) => {
        receivedInput = input;
        return {
          message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
          sessionsLoggedOut: 3,
        };
      },
    });

    await controller.logoutAll(
      {
        user: validatedSession.user,
        session: validatedSession.session,
        body: sensitiveActionBody,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentPassword: 'Password1!',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 3,
    });
    expectNoStore(state);
  });

  test('logs out other sessions while keeping the current authenticated session', async () => {
    let receivedInput:
      | { userId: string; currentSessionId: string; currentPassword: string }
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      logoutOtherSessions: async (input) => {
        receivedInput = input;
        return {
          message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
          sessionsLoggedOut: 2,
        };
      },
    });

    await controller.logoutOthers(
      {
        user: validatedSession.user,
        session: validatedSession.session,
        body: sensitiveActionBody,
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentSessionId: validatedSession.session.id,
      currentPassword: 'Password1!',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });
    expectNoStore(state);
  });

  test('logs out one session for the authenticated user', async () => {
    let receivedInput: { userId: string; sessionId: string } | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createTestAuthController({
      logoutSession: async (input) => {
        receivedInput = input;
        return {
          message: LOGOUT_SESSION_SUCCESS_MESSAGE,
          sessionsLoggedOut: 1,
        };
      },
    });

    await controller.logoutSession(
      {
        params: {
          sessionId: '123e4567-e89b-12d3-a456-426614174000',
        },
        user: validatedSession.user,
        session: validatedSession.session,
      } as unknown as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: LOGOUT_SESSION_SUCCESS_MESSAGE,
      sessionsLoggedOut: 1,
    });
    expectNoStore(state);
  });
});
