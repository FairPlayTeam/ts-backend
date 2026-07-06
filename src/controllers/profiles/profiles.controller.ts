import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type {
  FollowPublicProfileParams,
  GetPublicProfileParams,
  ListFollowingProfilesQuery,
  UnfollowPublicProfileParams,
} from '../profiles.schemas.js';
import { sendNoStoreJson } from '../http.responses.js';
import { toProfilesHttpError } from '../profiles.errors.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { ProfilesControllerDependencies } from './profiles.controller.types.js';
import {
  toFollowingProfilesResponse,
  toFollowPublicProfileResponse,
  toPublicProfileResponse,
} from './profiles.responses.js';

type GetPublicProfileRequest = Request<GetPublicProfileParams>;
type FollowPublicProfileRequest = Request<FollowPublicProfileParams>;
type ListFollowingProfilesRequest = Request<unknown, unknown, unknown, ListFollowingProfilesQuery>;
type UnfollowPublicProfileRequest = Request<UnfollowPublicProfileParams>;

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

  const followPublicProfile: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const followReq = req as FollowPublicProfileRequest;
      const result = await deps.profilesService.followPublicProfile({
        actorUserId: authenticatedReq.user.id,
        username: followReq.params.username,
      });

      return sendNoStoreJson(res, 200, toFollowPublicProfileResponse(result));
    } catch (err) {
      next(toProfilesHttpError(err));
    }
  };

  const listFollowingProfiles: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const followingReq = req as ListFollowingProfilesRequest;
      const { cursorFollowedAt, cursorId, limit } = followingReq.query;
      const cursor =
        cursorFollowedAt !== undefined && cursorId !== undefined
          ? {
              followedAt: new Date(cursorFollowedAt),
              id: cursorId,
            }
          : undefined;
      const result = await deps.profilesService.listFollowingProfiles({
        userId: authenticatedReq.user.id,
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      return sendNoStoreJson(res, 200, toFollowingProfilesResponse(result));
    } catch (err) {
      next(toProfilesHttpError(err));
    }
  };

  const unfollowPublicProfile: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const unfollowReq = req as UnfollowPublicProfileRequest;
      const result = await deps.profilesService.unfollowPublicProfile({
        actorUserId: authenticatedReq.user.id,
        username: unfollowReq.params.username,
      });

      return sendNoStoreJson(res, 200, toFollowPublicProfileResponse(result));
    } catch (err) {
      next(toProfilesHttpError(err));
    }
  };

  return {
    followPublicProfile,
    getPublicProfile,
    listFollowingProfiles,
    unfollowPublicProfile,
  };
};
