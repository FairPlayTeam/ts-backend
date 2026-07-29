import type { Request, RequestHandler } from 'express';
import type {
  AdminVideoParams,
  AdminVideosQuery,
  ModerateAdminVideoBody,
} from '../admin.schemas.js';
import { toAdminHttpError } from '../admin.errors.js';
import { sendNoStoreJson } from '../http.responses.js';
import type { AdminControllerDependencies } from './admin.controller.types.js';
import { toAdminVideosResponse, toModerateAdminVideoResponse } from './admin.responses.js';

type ListVideosRequest = Request<unknown, unknown, unknown, AdminVideosQuery>;
type ModerateVideoRequest = Request<AdminVideoParams, unknown, ModerateAdminVideoBody>;

export const createAdminVideosController = (deps: AdminControllerDependencies) => {
  const listVideos: RequestHandler = async (req, res, next) => {
    try {
      const listReq = req as ListVideosRequest;
      const { cursorCreatedAt, cursorId, limit, moderationStatus, processingStatus, search, sort } =
        listReq.query;
      const result = await deps.adminService.listVideos({
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
      const moderationReq = req as ModerateVideoRequest;
      const result = await deps.adminService.moderateVideo({
        videoId: moderationReq.params.videoId,
        decision: moderationReq.body.decision,
      });

      return sendNoStoreJson(res, 200, toModerateAdminVideoResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  return {
    listVideos,
    moderateVideo,
  };
};
