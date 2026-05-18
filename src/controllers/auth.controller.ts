import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { toAuthHttpError } from './auth.errors.js';
import type {
  LoginRequestBody,
  RegisterRequestBody,
  ResendVerificationRequestBody,
  VerifyEmailRequestBody,
} from './auth.schemas.js';

type AuthSessionResult = {
  message: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
  sessionKey: string;
  session: {
    id: string;
    expiresAt: Date;
  };
};

type ValidatedAuthSession = {
  user: AuthSessionResult['user'];
  session: AuthSessionResult['session'];
};

export type AuthService = {
  register(input: RegisterRequestBody): Promise<{ message: string }>;
  login(
    input: LoginRequestBody & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  verifyEmail(
    input: VerifyEmailRequestBody & {
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<AuthSessionResult>;
  validateSession(sessionKey: string): Promise<ValidatedAuthSession | null>;
  resendVerification(input: ResendVerificationRequestBody): Promise<{ message: string }>;
};

type AuthControllerDependencies = {
  authService: AuthService;
};

const toAuthSessionResponse = (result: AuthSessionResult) => ({
  message: result.message,
  user: result.user,
  sessionKey: result.sessionKey,
  session: {
    id: result.session.id,
    expiresAt: result.session.expiresAt.toISOString(),
  },
});

const toAuthenticatedSessionResponse = (req: AuthenticatedRequest) => ({
  user: req.user,
  session: {
    id: req.session.id,
    expiresAt: req.session.expiresAt.toISOString(),
  },
});

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

      return res.status(200).json(toAuthSessionResponse(result));
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

      return res.status(200).json(toAuthSessionResponse(result));
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

  const me = (req: Request, res: Response) => {
    return res.status(200).json(toAuthenticatedSessionResponse(req as AuthenticatedRequest));
  };

  return { register, login, verifyEmail, resendVerification, me };
};
