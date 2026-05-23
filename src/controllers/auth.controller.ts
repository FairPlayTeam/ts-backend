import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { toAuthHttpError } from './auth.errors.js';
import type {
  LoginRequestBody,
  LogoutSessionParams,
  RegisterRequestBody,
  ResendVerificationRequestBody,
  UpdateProfileRequestBody,
  VerifyEmailRequestBody,
} from './auth.schemas.js';
import type { AuthService, AuthSessionResult, UserSessionSummary } from '../services/auth.types.js';

type AuthControllerDependencies = {
  authService: Omit<AuthService, 'cleanupSessions'>;
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

const toUserSessionsResponse = ({
  sessions,
  total,
}: {
  sessions: UserSessionSummary[];
  total: number;
}) => ({
  sessions: sessions.map((session) => ({
    id: session.id,
    sessionKeySuffix: session.sessionKeySuffix,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    deviceInfo: session.deviceInfo,
    isCurrent: session.isCurrent,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  })),
  total,
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

  const sessions = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.getUserSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
      });

      return res.status(200).json(toUserSessionsResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutAllSessions({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutOthers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutOtherSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const { sessionId } = req.params as LogoutSessionParams;
      const result = await deps.authService.logoutSession({
        userId: authenticatedReq.user.id,
        sessionId,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const updateMe = async (
    req: Request<unknown, unknown, UpdateProfileRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;

      const result = await deps.authService.updateProfile({
        userId: authenticatedReq.user.id,
        ...req.body,
      });

      return res.status(200).json({
        message: result.message,
        user: result.user,
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
    me,
    updateMe,
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
  };
};
