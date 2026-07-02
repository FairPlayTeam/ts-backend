import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { toAuthHttpError } from '../auth.errors.js';
import type { AuthControllerDependencies } from './auth.controller.types.js';
import {
  sendNoStoreJson,
  toUserMediaAssetResponse,
  toUserMediaFileInput,
} from './auth.responses.js';

export const createAuthMediaController = (deps: AuthControllerDependencies) => {
  const uploadAvatar = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.uploadAvatar({
        userId: authenticatedReq.user.id,
        file: toUserMediaFileInput(req.file),
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        avatar: toUserMediaAssetResponse(result.avatar),
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const deleteAvatar = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.deleteAvatar({
        userId: authenticatedReq.user.id,
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        avatar: result.avatar,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const uploadBanner = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.uploadBanner({
        userId: authenticatedReq.user.id,
        file: toUserMediaFileInput(req.file),
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        banner: toUserMediaAssetResponse(result.banner),
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const deleteBanner = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.deleteBanner({
        userId: authenticatedReq.user.id,
      });

      return sendNoStoreJson(res, 200, {
        message: result.message,
        banner: result.banner,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  return {
    uploadAvatar,
    deleteAvatar,
    uploadBanner,
    deleteBanner,
  };
};
