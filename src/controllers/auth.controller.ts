import type { NextFunction, Request, Response } from 'express';
import { toAuthHttpError } from './auth.errors.js';
import type { RegisterRequestBody } from './auth.schemas.js';

type AuthService = {
  register(input: RegisterRequestBody): Promise<{ message: string }>;
};

type AuthControllerDependencies = {
  authService: AuthService;
};

export const createAuthController = (deps: AuthControllerDependencies) => {
  const register = async (
    req: Request<unknown, unknown, RegisterRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await deps.authService.register(req.body);

      return res.status(201).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  return { register };
};
