import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { createAuthController } from '../src/controllers/auth.controller.js';
import type {
  LoginRequestBody,
  RegisterRequestBody,
  ResendVerificationRequestBody,
  VerifyEmailRequestBody,
} from '../src/controllers/auth.schemas.js';
import { HttpError } from '../src/errors/http.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';

const registerBody: RegisterRequestBody = {
  email: 'user@example.com',
  username: 'fairplay_user',
  password: 'Password1!',
};

const resendVerificationBody: ResendVerificationRequestBody = {
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
  message: 'Login successful',
  user: {
    id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    email: 'user@example.com',
    username: 'fairplay_user',
    role: 'user',
  },
  sessionKey: 'plain-session-key',
  session: {
    id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    expiresAt: new Date('2026-01-31T00:00:00.000Z'),
  },
};

const verifyEmailResult = {
  ...loginResult,
  message: 'Email successfully verified',
};

const validatedSession = {
  user: loginResult.user,
  session: loginResult.session,
};

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
    const controller = createAuthController({
      authService: {
        register: async (input) => {
          receivedInput = input;
          return { message: 'Account created. Please verify your email.' };
        },
        login: async () => loginResult,
        verifyEmail: async () => verifyEmailResult,
        validateSession: async () => validatedSession,
        resendVerification: async () => ({
          message: 'If this email exists and is unverified, a new link has been sent.',
        }),
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
      message: 'Account created. Please verify your email.',
    });
  });

  test('maps known auth service errors before passing them to next', async () => {
    let receivedError: unknown;
    const { response } = createMockResponse();
    const controller = createAuthController({
      authService: {
        register: async () => {
          throw new UserAlreadyExistsError();
        },
        login: async () => loginResult,
        verifyEmail: async () => verifyEmailResult,
        validateSession: async () => validatedSession,
        resendVerification: async () => ({
          message: 'If this email exists and is unverified, a new link has been sent.',
        }),
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
    const controller = createAuthController({
      authService: {
        register: async () => ({ message: 'Account created. Please verify your email.' }),
        login: async () => loginResult,
        verifyEmail: async () => verifyEmailResult,
        validateSession: async () => validatedSession,
        resendVerification: async (input) => {
          receivedInput = input;
          return {
            message: 'If this email exists and is unverified, a new link has been sent.',
          };
        },
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
      message: 'If this email exists and is unverified, a new link has been sent.',
    });
  });

  test('logs in through the injected auth service', async () => {
    let receivedInput:
      | (LoginRequestBody & { ipAddress?: string | undefined; userAgent?: string | undefined })
      | undefined;
    let receivedError: unknown;
    const { response, state } = createMockResponse();
    const controller = createAuthController({
      authService: {
        register: async () => ({ message: 'Account created. Please verify your email.' }),
        login: async (input) => {
          receivedInput = input;
          return loginResult;
        },
        verifyEmail: async () => verifyEmailResult,
        validateSession: async () => validatedSession,
        resendVerification: async () => ({
          message: 'If this email exists and is unverified, a new link has been sent.',
        }),
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
    const controller = createAuthController({
      authService: {
        register: async () => ({ message: 'Account created. Please verify your email.' }),
        login: async () => loginResult,
        verifyEmail: async (input) => {
          receivedInput = input;
          return verifyEmailResult;
        },
        validateSession: async () => validatedSession,
        resendVerification: async () => ({
          message: 'If this email exists and is unverified, a new link has been sent.',
        }),
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
});
