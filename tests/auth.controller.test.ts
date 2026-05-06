import { describe, expect, test } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { createAuthController } from '../src/controllers/auth.controller.js';
import type { RegisterRequestBody } from '../src/controllers/auth.schemas.js';
import { HttpError } from '../src/errors/http.js';
import { UserAlreadyExistsError } from '../src/services/auth.errors.js';

const registerBody: RegisterRequestBody = {
  email: 'user@example.com',
  username: 'fairplay_user',
  password: 'Password1!',
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
});
