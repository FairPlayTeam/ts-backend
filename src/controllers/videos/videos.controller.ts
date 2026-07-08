import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sendNoStoreJson } from '../http.responses.js';
import { toVideosHttpError } from '../videos.errors.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type {
  CompleteVideoMultipartUploadBody,
  CreateVideoBody,
  SignVideoMultipartUploadPartsBody,
  VideoMultipartUploadSessionParams,
  VideoParams,
} from '../videos.schemas.js';
import type { VideosControllerDependencies } from './videos.controller.types.js';
import {
  toCreateVideoResponse,
  toSignedVideoUploadPartsResponse,
  toVideoUploadSessionResponse,
} from './videos.responses.js';

type VideoRequest = Request<VideoParams>;
type VideoUploadSessionRequest = Request<VideoMultipartUploadSessionParams>;
type SignPartsRequest = Request<
  VideoMultipartUploadSessionParams,
  unknown,
  SignVideoMultipartUploadPartsBody
>;
type CompleteRequest = Request<
  VideoMultipartUploadSessionParams,
  unknown,
  CompleteVideoMultipartUploadBody
>;
type CreateVideoRequest = Request<unknown, unknown, CreateVideoBody>;

export const createVideosController = ({ videosService }: VideosControllerDependencies) => {
  const createVideo: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const createReq = req as CreateVideoRequest;
      const result = await videosService.createVideo({
        userId: authenticatedReq.user.id,
        title: createReq.body.title,
        description: createReq.body.description ?? null,
        tags: createReq.body.tags,
        license: createReq.body.license,
        visibility: createReq.body.visibility,
        allowComments: createReq.body.allowComments,
      });

      return sendNoStoreJson(res, 201, toCreateVideoResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const initMultipartUpload: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const videoReq = req as VideoRequest;
      const result = await videosService.initMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId: videoReq.params.videoId,
      });

      return sendNoStoreJson(res, 201, toVideoUploadSessionResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const signMultipartUploadParts: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const signReq = req as SignPartsRequest;
      const result = await videosService.signMultipartUploadParts({
        userId: authenticatedReq.user.id,
        videoId: signReq.params.videoId,
        uploadSessionId: signReq.params.uploadSessionId,
        partNumbers: signReq.body.partNumbers,
      });

      return sendNoStoreJson(res, 200, toSignedVideoUploadPartsResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const completeMultipartUpload: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const completeReq = req as CompleteRequest;
      const result = await videosService.completeMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId: completeReq.params.videoId,
        uploadSessionId: completeReq.params.uploadSessionId,
        parts: completeReq.body.parts,
      });

      return sendNoStoreJson(res, 200, toVideoUploadSessionResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const abortMultipartUpload: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const sessionReq = req as VideoUploadSessionRequest;
      const result = await videosService.abortMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId: sessionReq.params.videoId,
        uploadSessionId: sessionReq.params.uploadSessionId,
      });

      return sendNoStoreJson(res, 200, toVideoUploadSessionResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getMultipartUploadSession: RequestHandler = async (
    req,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const sessionReq = req as VideoUploadSessionRequest;
      const result = await videosService.getMultipartUploadSession({
        userId: authenticatedReq.user.id,
        videoId: sessionReq.params.videoId,
        uploadSessionId: sessionReq.params.uploadSessionId,
      });

      return sendNoStoreJson(res, 200, toVideoUploadSessionResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  return {
    abortMultipartUpload,
    completeMultipartUpload,
    createVideo,
    getMultipartUploadSession,
    initMultipartUpload,
    signMultipartUploadParts,
  };
};
