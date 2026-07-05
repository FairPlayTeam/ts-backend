import type { NextFunction, Request, Response } from 'express';
import type { GetPublicProfileParams } from '../profiles.schemas.js';
import { sendNoStoreJson } from '../http.responses.js';
import { toProfilesHttpError } from '../profiles.errors.js';
import type { ProfilesControllerDependencies } from './profiles.controller.types.js';
import { toPublicProfileResponse } from './profiles.responses.js';

type GetPublicProfileRequest = Request<GetPublicProfileParams>;

export const createProfilesController = (deps: ProfilesControllerDependencies) => {
  const getPublicProfile = async (
    req: GetPublicProfileRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await deps.profilesService.getPublicProfile({
        username: req.params.username,
      });

      return sendNoStoreJson(res, 200, toPublicProfileResponse(result));
    } catch (err) {
      next(toProfilesHttpError(err));
    }
  };

  return {
    getPublicProfile,
  };
};
