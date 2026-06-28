import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors/http.js';
import type { AuthSessionValidationPort, ValidatedAuthSession } from '../services/auth.types.js';

export const AUTH_SESSION_REQUIRED_MESSAGE = 'Bearer session token is required';
export const INVALID_AUTH_SESSION_MESSAGE = 'Invalid or expired session';
const DEFAULT_AUTHENTICATED_SESSION_CONFLICT_MESSAGE =
  'Already authenticated users cannot access this route';

type AuthenticatedUser = ValidatedAuthSession['user'];
type AuthenticatedSession = ValidatedAuthSession['session'];

export type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
  session: AuthenticatedSession;
};

type AuthMiddlewareDependencies = {
  authService: AuthSessionValidationPort;
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
      next(new HttpError(401, 'Unauthorized', AUTH_SESSION_REQUIRED_MESSAGE));
      return;
    }

    try {
      const result = await authService.validateSession(sessionKey);

      if (!result) {
        next(new HttpError(401, 'Unauthorized', INVALID_AUTH_SESSION_MESSAGE));
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
  conflictMessage = DEFAULT_AUTHENTICATED_SESSION_CONFLICT_MESSAGE,
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
