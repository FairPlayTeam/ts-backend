import type { Request, RequestHandler } from 'express';
import { HttpError } from '../errors/http.js';
import {
  createAuthenticateSession,
  createRejectAuthenticatedSession,
  type AuthenticatedRequest,
} from './auth.js';
import type { AuthRole } from '../services/auth.types.js';

type AuthServiceForProtection = {
  validateSession: Parameters<
    typeof createAuthenticateSession
  >[0]['authService']['validateSession'];
};

type RouteProtectorDependencies = {
  authService: AuthServiceForProtection;
};

type AuthenticatedProtection = {
  access?: 'authenticated';
  roles?: readonly AuthRole[];
};

type GuestProtection = {
  access: 'guest';
  conflictMessage?: string;
};

type ProtectionOptions = AuthenticatedProtection | GuestProtection;

const hasAuthContext = (req: Request): req is AuthenticatedRequest => {
  const candidate = req as Partial<AuthenticatedRequest>;
  return candidate.user !== undefined && candidate.session !== undefined;
};

const requireRoles = (roles: readonly AuthRole[]): RequestHandler => {
  const allowedRoles = new Set<AuthRole>(roles);

  return (req, _res, next) => {
    if (!hasAuthContext(req)) {
      next(new HttpError(500, 'InternalServerError', 'Route protection misconfigured'));
      return;
    }

    if (!allowedRoles.has(req.user.role)) {
      next(new HttpError(403, 'Forbidden', 'Insufficient permissions'));
      return;
    }

    next();
  };
};

export const createRouteProtector = ({ authService }: RouteProtectorDependencies) => {
  const authenticate = createAuthenticateSession({ authService });

  return (options: ProtectionOptions = {}): RequestHandler[] => {
    if (options.access === 'guest') {
      const rejectAuthenticated = createRejectAuthenticatedSession({
        authService,
        ...(options.conflictMessage !== undefined
          ? { conflictMessage: options.conflictMessage }
          : {}),
      });

      return [rejectAuthenticated];
    }

    const handlers: RequestHandler[] = [authenticate];

    if (options.roles?.length) {
      handlers.push(requireRoles(options.roles));
    }

    return handlers;
  };
};
