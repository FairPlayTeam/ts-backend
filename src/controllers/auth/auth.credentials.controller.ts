import type { NextFunction, Request, Response } from 'express';
import { toAuthHttpError } from '../auth.errors.js';
import type {
  LoginRequestBody,
  RegisterRequestBody,
  RequestPasswordResetRequestBody,
  ResendVerificationRequestBody,
  ResetPasswordRequestBody,
  VerifyEmailRequestBody,
} from '../auth.schemas.js';
import type { AuthControllerDependencies } from './auth.controller.types.js';
import { sendNoStoreJson, toAuthSessionResponse } from './auth.responses.js';

export const createAuthCredentialsController = (deps: AuthControllerDependencies) => {
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

  const login = async (
    req: Request<unknown, unknown, LoginRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userAgent = req.get('user-agent');
      const result = await deps.authService.login({
        ...req.body,
        ipAddress: req.ip,
        userAgent,
      });

      return sendNoStoreJson(res, 200, toAuthSessionResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const verifyEmail = async (
    req: Request<unknown, unknown, VerifyEmailRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userAgent = req.get('user-agent');
      const result = await deps.authService.verifyEmail({
        ...req.body,
        ipAddress: req.ip,
        userAgent,
      });

      return sendNoStoreJson(res, 200, toAuthSessionResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const resendVerification = async (
    req: Request<unknown, unknown, ResendVerificationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await deps.authService.resendVerification(req.body);

      return res.status(200).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const requestPasswordReset = async (
    req: Request<unknown, unknown, RequestPasswordResetRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { email } = req.body;

      const result = await deps.authService.requestPasswordReset({
        email,
      });

      return res.status(200).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const resetPassword = async (
    req: Request<unknown, unknown, ResetPasswordRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { email, code, password } = req.body;

      const result = await deps.authService.resetPassword({
        email,
        code,
        password,
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  return {
    register,
    login,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    resetPassword,
  };
};
