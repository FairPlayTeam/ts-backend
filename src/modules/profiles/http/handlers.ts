import type { Request, RequestHandler, Response } from 'express';
import type {
  FollowPublicProfileParams,
  GetProfileMediaParams,
  GetPublicProfileParams,
  ListPublicProfileVideosParams,
  ListPublicProfileVideosQuery,
  ListFollowingProfilesQuery,
  UnfollowPublicProfileParams,
} from './schemas.js';
import {
  allowPublicCrossOriginMedia,
  sendNoStoreJson,
} from '../../../controllers/http.responses.js';
import { toProfilesHttpError } from './errorMapper.js';
import type {
  AuthenticatedRequest,
  OptionallyAuthenticatedRequest,
} from '../../../middleware/auth.js';
import type { VideosRoutePort } from '../../../services/videos.types.js';
import type { ProfilesPort } from '../types.js';
import {
  toFollowingProfilesResponse,
  toFollowPublicProfileResponse,
  toPublicProfileResponse,
} from './responses.js';
import { toPublicVideosResponse } from '../../../controllers/videos/videos.responses.js';
import { mapHandlerErrors } from '../../../shared/http/mapHandlerErrors.js';

type ProfilesControllerDependencies = {
  profilesService: ProfilesPort;
  videosService: Pick<VideosRoutePort, 'listPublicProfileVideos'>;
};

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
  const getProfileMedia = (kind: 'avatar' | 'banner'): RequestHandler =>
    mapHandlerErrors(toProfilesHttpError, async (req, res) => {
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
    });
  const getAvatar = getProfileMedia('avatar');
  const getBanner = getProfileMedia('banner');

  const getPublicProfile = mapHandlerErrors(
    toProfilesHttpError,
    async (req: GetPublicProfileRequest, res: Response) => {
      const optionallyAuthenticatedReq = req as GetPublicProfileRequest &
        OptionallyAuthenticatedRequest;
      const result = await deps.profilesService.getPublicProfile({
        username: req.params.username,
        ...(optionallyAuthenticatedReq.user
          ? { viewerUserId: optionallyAuthenticatedReq.user.id }
          : {}),
      });

      return sendNoStoreJson(res, 200, toPublicProfileResponse(result));
    },
  );

  const listPublicProfileVideos: RequestHandler = mapHandlerErrors(
    toProfilesHttpError,
    async (req, res) => {
      const listReq = req as ListPublicProfileVideosRequest;
      const { cursorCreatedAt, cursorPublicId, limit } = listReq.query;
      const { profileUserId } = await deps.profilesService.getPublicProfile({
        username: listReq.params.username,
      });
      const result = await deps.videosService.listPublicProfileVideos({
        ownerId: profileUserId,
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
    },
  );

  const followPublicProfile: RequestHandler = mapHandlerErrors(
    toProfilesHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const followReq = req as FollowPublicProfileRequest;
      const result = await deps.profilesService.followPublicProfile({
        actorUserId: authenticatedReq.user.id,
        username: followReq.params.username,
      });

      return sendNoStoreJson(res, 200, toFollowPublicProfileResponse(result));
    },
  );

  const listFollowingProfiles: RequestHandler = mapHandlerErrors(
    toProfilesHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const followingReq = req as ListFollowingProfilesRequest;
      const { cursor, limit } = followingReq.query;
      const result = await deps.profilesService.listFollowingProfiles({
        userId: authenticatedReq.user.id,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      return sendNoStoreJson(res, 200, toFollowingProfilesResponse(result));
    },
  );

  const unfollowPublicProfile: RequestHandler = mapHandlerErrors(
    toProfilesHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const unfollowReq = req as UnfollowPublicProfileRequest;
      const result = await deps.profilesService.unfollowPublicProfile({
        actorUserId: authenticatedReq.user.id,
        username: unfollowReq.params.username,
      });

      return sendNoStoreJson(res, 200, toFollowPublicProfileResponse(result));
    },
  );

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
