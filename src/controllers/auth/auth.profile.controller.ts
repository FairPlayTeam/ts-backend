import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { toAuthHttpError } from '../auth.errors.js';
import type {
  SensitiveActionReauthenticationRequestBody,
  UpdateProfileRequestBody,
} from '../auth.schemas.js';
import type { AuthControllerDependencies } from './auth.controller.types.js';
import { toPrettyJson, toSessionResponse, toUserDataExportResponse } from './auth.responses.js';

export const createAuthProfileController = (deps: AuthControllerDependencies) => {
  const me = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.getProfile({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        user: result.user,
        session: toSessionResponse(authenticatedReq.session),
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const exportMe = async (
    req: Request<unknown, unknown, SensitiveActionReauthenticationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.exportUserData({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
        currentPassword: req.body.currentPassword,
      });

      res.set('Content-Disposition', 'attachment; filename="fairplay-user-data-export.json"');

      return res
        .status(200)
        .type('application/json')
        .send(toPrettyJson(toUserDataExportResponse(result)));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const deleteMe = async (
    req: Request<unknown, unknown, SensitiveActionReauthenticationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.deleteAccount({
        userId: authenticatedReq.user.id,
        currentPassword: req.body.currentPassword,
      });

      return res.status(200).json({
        message: result.message,
        mediaCleanupQueued: result.mediaCleanupQueued,
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
    me,
    exportMe,
    deleteMe,
    updateMe,
  };
};
