import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { toAuthHttpError } from '../auth.errors.js';
import type {
  LogoutSessionParams,
  SensitiveActionReauthenticationRequestBody,
  UserSessionsQuery,
} from '../auth.schemas.js';
import type { AuthControllerDependencies } from './auth.controller.types.js';
import { sendNoStoreJson, toUserSessionsResponse } from './auth.responses.js';

export const createAuthSessionsController = (deps: AuthControllerDependencies) => {
  const sessions = async (
    req: Request<unknown, unknown, unknown, UserSessionsQuery>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const { limit, cursorLastUsedAt, cursorId } = req.query;
      const cursor =
        cursorLastUsedAt && cursorId
          ? {
              lastUsedAt: new Date(cursorLastUsedAt),
              id: cursorId,
            }
          : undefined;
      const result = await deps.authService.getUserSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });

      return sendNoStoreJson(res, 200, toUserSessionsResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutAll = async (
    req: Request<unknown, unknown, SensitiveActionReauthenticationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutAllSessions({
        userId: authenticatedReq.user.id,
        currentPassword: req.body.currentPassword,
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutOthers = async (
    req: Request<unknown, unknown, SensitiveActionReauthenticationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutOtherSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
        currentPassword: req.body.currentPassword,
      });

      return sendNoStoreJson(res, 200, {
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

      return sendNoStoreJson(res, 200, {
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  return {
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
  };
};
