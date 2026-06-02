import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { createAuthController } from '../src/controllers/auth.controller.js';
import type { AuthenticatedRequest } from '../src/middleware/auth.js';
import type {
  LoginRequestBody,
  RegisterRequestBody,
  RequestPasswordResetRequestBody,
  ResendVerificationRequestBody,
  UpdateProfileRequestBody,
  UserSessionsQuery,
  VerifyEmailRequestBody,
} from '../src/controllers/auth.schemas.js';
import { HttpError } from '../src/errors/http.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';
import {
  LOGIN_SUCCESS_MESSAGE,
  LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
  LOGOUT_SESSION_SUCCESS_MESSAGE,
  REGISTER_SUCCESS_MESSAGE,
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
  RESET_PASSWORD_SUCCESS_MESSAGE,
  UPDATE_PROFILE_SUCCESS_MESSAGE,
  VERIFY_EMAIL_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';
import type { AuthService } from '../src/services/auth.types.js';

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

const loginBody: LoginRequestBody = {
  emailOrUsername: 'user@example.com',
  password: 'Password1!',
};

const verifyEmailBody: VerifyEmailRequestBody = {
  token: 'a'.repeat(64),
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

type ControllerAuthService = Omit<AuthService, 'cleanupExpiredAuthTokens' | 'cleanupSessions'>;

const createControllerAuthService = (
  overrides: Partial<ControllerAuthService> = {},
): ControllerAuthService => ({
  register: async () => ({ message: REGISTER_SUCCESS_MESSAGE }),
  login: async () => loginResult,
  verifyEmail: async () => verifyEmailResult,
  validateSession: async () => validatedSession,
  resendVerification: async () => ({ message: RESEND_VERIFICATION_EMAIL_MESSAGE }),
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
  requestPasswordReset: async () => ({ message: RESET_PASSWORD_EMAIL_MESSAGE }),
  resetPassword: async () => ({
    message: RESET_PASSWORD_SUCCESS_MESSAGE,
    sessionsLoggedOut: 1,
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
  } = {};

  const response = {
    status(statusCode: number) {
      state.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  } as unknown as Response;

  return { response, state };
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
  });

  test('returns the authenticated user profile from request context', () => {
    const { response, state } = createMockResponse();
    const controller = createTestAuthController();

    controller.me(
      {
        user: validatedSession.user,
        session: validatedSession.session,
      } as AuthenticatedRequest,
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      user: validatedSession.user,
      session: {
        id: validatedSession.session.id,
        expiresAt: '2026-01-31T00:00:00.000Z',
      },
    });
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
  });

  test('logs out all sessions for the authenticated user', async () => {
    let receivedInput: { userId: string } | undefined;
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
      message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 3,
    });
  });

  test('logs out other sessions while keeping the current authenticated session', async () => {
    let receivedInput: { userId: string; currentSessionId: string } | undefined;
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
      } as AuthenticatedRequest,
      response,
      ((err?: unknown) => {
        receivedError = err;
      }) as NextFunction,
    );

    expect(receivedInput).toEqual({
      userId: validatedSession.user.id,
      currentSessionId: validatedSession.session.id,
    });
    expect(receivedError).toBeUndefined();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
      sessionsLoggedOut: 2,
    });
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
  });
});
