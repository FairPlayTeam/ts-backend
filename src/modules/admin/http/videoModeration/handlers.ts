import type { Request, RequestHandler } from 'express';
import type {
  AdminVideoParams,
  AdminVideosQuery,
  ModerateAdminVideoBody,
  RequestAdminVideoDeletionBody,
} from './schemas.js';
import { toAdminHttpError } from '../errorMapper.js';
import { sendNoStoreJson } from '../../../../controllers/http.responses.js';
import type { AuthenticatedRequest } from '../../../../middleware/auth.js';
import type { VideoModerationPort } from '../../videoModeration/types.js';
import {
  toAdminVideosResponse,
  toModerateAdminVideoResponse,
  toRequestAdminVideoDeletionResponse,
} from './responses.js';

type VideoModerationHandlerDependencies = {
  videoModerationService: VideoModerationPort;
};

type ListVideosRequest = Request<unknown, unknown, unknown, AdminVideosQuery>;
type ModerateVideoRequest = Request<AdminVideoParams, unknown, ModerateAdminVideoBody>;
type RequestVideoDeletionRequest = Request<
  AdminVideoParams,
  unknown,
  RequestAdminVideoDeletionBody
>;

export const createVideoModerationHandlers = (deps: VideoModerationHandlerDependencies) => {
  const listVideos: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const listReq = req as ListVideosRequest;
      const { cursorCreatedAt, cursorId, limit, moderationStatus, processingStatus, search, sort } =
        listReq.query;
      const result = await deps.videoModerationService.listVideos({
        actorUserId: authenticatedReq.user.id,
        ...(limit === undefined ? {} : { limit }),
        ...(moderationStatus === undefined ? {} : { moderationStatus }),
        ...(processingStatus === undefined ? {} : { processingStatus }),
        ...(search === undefined ? {} : { search }),
        ...(sort === undefined ? {} : { sort }),
        ...(cursorCreatedAt !== undefined && cursorId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                id: cursorId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toAdminVideosResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  const moderateVideo: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const moderationReq = req as ModerateVideoRequest;
      const result = await deps.videoModerationService.moderateVideo(
        moderationReq.body.decision === 'rejected'
          ? {
              actorUserId: authenticatedReq.user.id,
              videoId: moderationReq.params.videoId,
              decision: 'rejected',
              reason: moderationReq.body.reason,
            }
          : {
              actorUserId: authenticatedReq.user.id,
              videoId: moderationReq.params.videoId,
              decision: 'approved',
            },
      );

      return sendNoStoreJson(res, 200, toModerateAdminVideoResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  const requestVideoDeletion: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const deletionReq = req as RequestVideoDeletionRequest;

      const result = await deps.videoModerationService.requestVideoDeletion({
        actorUserId: authenticatedReq.user.id,
        reason: deletionReq.body.reason,
        videoId: deletionReq.params.videoId,
      });

      return sendNoStoreJson(res, 200, toRequestAdminVideoDeletionResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  return {
    listVideos,
    moderateVideo,
    requestVideoDeletion,
  };
};
