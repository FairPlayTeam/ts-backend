import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors/http.js';
import type { AuthUser } from '../services/auth.types.js';

type AuthenticatedUser = AuthUser;

type AuthenticatedSession = {
  id: string;
  expiresAt: Date;
};

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
};

type SessionValidationResult = {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
};

type AuthMiddlewareDependencies = {
  authService: {
    validateSession(sessionKey: string): Promise<SessionValidationResult | null>;
  };
};

type RejectAuthenticatedSessionDependencies = AuthMiddlewareDependencies & {
  conflictMessage?: string;
};

const parseBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) {
    return null;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];

  return token || null;
};

export const createAuthenticateSession = ({
  authService,
}: AuthMiddlewareDependencies): RequestHandler => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const sessionKey = parseBearerToken(req.headers.authorization);

    if (!sessionKey) {
      next(new HttpError(401, 'Unauthorized', 'Bearer session token is required'));
      return;
    }

    try {
      const result = await authService.validateSession(sessionKey);

      if (!result) {
        next(new HttpError(401, 'Unauthorized', 'Invalid or expired session'));
        return;
      }

      const authenticatedReq = req as AuthenticatedRequest;
      authenticatedReq.user = result.user;
      authenticatedReq.session = result.session;

      next();
    } catch (err) {
      next(err);
    }
  };
};

export const createRejectAuthenticatedSession = ({
  authService,
  conflictMessage = 'Already authenticated users cannot access this route',
}: RejectAuthenticatedSessionDependencies): RequestHandler => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const sessionKey = parseBearerToken(req.headers.authorization);

    if (!sessionKey) {
      next();
      return;
    }

    try {
      const result = await authService.validateSession(sessionKey);

      if (result) {
        next(new HttpError(409, 'Conflict', conflictMessage));
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
