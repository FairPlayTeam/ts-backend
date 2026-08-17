import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type {
  FollowPublicProfileParams,
  GetProfileMediaParams,
  GetPublicProfileParams,
  ListPublicProfileVideosParams,
  ListPublicProfileVideosQuery,
  ListFollowingProfilesQuery,
  UnfollowPublicProfileParams,
} from '../profiles.schemas.js';
import { allowPublicCrossOriginMedia, sendNoStoreJson } from '../http.responses.js';
import { toProfilesHttpError } from '../profiles.errors.js';
import type {
  AuthenticatedRequest,
  OptionallyAuthenticatedRequest,
} from '../../middleware/auth.js';
import type { ProfilesControllerDependencies } from './profiles.controller.types.js';
import {
  toFollowingProfilesResponse,
  toFollowPublicProfileResponse,
  toPublicProfileResponse,
} from './profiles.responses.js';
import { toPublicVideosResponse } from '../videos/videos.responses.js';

type GetPublicProfileRequest = Request<GetPublicProfileParams>;
type ListPublicProfileVideosRequest = Request<
  ListPublicProfileVideosParams,
  unknown,
  unknown,
  ListPublicProfileVideosQuery
>;
type GetProfileMediaRequest = Request<GetProfileMediaParams>;
type FollowPublicProfileRequest = Request<FollowPublicProfileParams>;
type ListFollowingProfilesRequest = Request<unknown, unknown, unknown, ListFollowingProfilesQuery>;
type UnfollowPublicProfileRequest = Request<UnfollowPublicProfileParams>;

export const createProfilesController = (deps: ProfilesControllerDependencies) => {
  const getProfileMedia =
    (kind: 'avatar' | 'banner'): RequestHandler =>
    async (req, res, next) => {
      try {
        const mediaReq = req as GetProfileMediaRequest;
        const result = await deps.profilesService.getProfileMedia({
          username: mediaReq.params.username,
          kind,
        });

        return allowPublicCrossOriginMedia(res)
          .status(200)
          .set('Cache-Control', 'private, no-cache')
          .set('Content-Length', String(result.body.length))
          .type(result.mimeType)
          .send(result.body);
      } catch (err) {
        next(toProfilesHttpError(err));
      }
    };
  const getAvatar = getProfileMedia('avatar');
  const getBanner = getProfileMedia('banner');

  const getPublicProfile = async (
    req: GetPublicProfileRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const optionallyAuthenticatedReq = req as GetPublicProfileRequest &
        OptionallyAuthenticatedRequest;
      const result = await deps.profilesService.getPublicProfile({
        username: req.params.username,
        ...(optionallyAuthenticatedReq.user
          ? { viewerUserId: optionallyAuthenticatedReq.user.id }
          : {}),
      });

      return sendNoStoreJson(res, 200, toPublicProfileResponse(result));
    } catch (err) {
      next(toProfilesHttpError(err));
    }
  };

  const listPublicProfileVideos: RequestHandler = async (req, res, next) => {
    try {
      const listReq = req as ListPublicProfileVideosRequest;
      const { cursorCreatedAt, cursorPublicId, limit } = listReq.query;
      const { profile } = await deps.profilesService.getPublicProfile({
        username: listReq.params.username,
      });
      const result = await deps.videosService.listPublicProfileVideos({
        ownerId: profile.id,
        ...(limit === undefined ? {} : { limit }),
        ...(cursorCreatedAt !== undefined && cursorPublicId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                publicId: cursorPublicId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toPublicVideosResponse(result));
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
    getAvatar,
    getBanner,
    getPublicProfile,
    listPublicProfileVideos,
    listFollowingProfiles,
    unfollowPublicProfile,
  };
};
