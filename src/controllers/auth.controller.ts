import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/authService.js';
import { toAuthHttpError } from './auth.errors.js';
import type { RegisterRequestBody } from './auth.schemas.js';

export const register = async (
  req: Request<unknown, unknown, RegisterRequestBody>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await authService.register(req.body);

    return res.status(201).json({
      message: result.message,
    });
  } catch (err) {
    next(toAuthHttpError(err));
  }
};
