import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sendNoStoreJson } from '../http.responses.js';
import { toVideosHttpError } from '../videos.errors.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type {
  CompleteVideoMultipartUploadBody,
  CreateVideoBody,
  InitVideoMultipartUploadBody,
  ListMyVideosQuery,
  SignVideoMultipartUploadPartsBody,
  VideoHlsMasterParams,
  VideoHlsRenditionParams,
  VideoHlsSegmentParams,
  VideoMultipartUploadSessionParams,
  VideoParams,
} from '../videos.schemas.js';
import type { VideosControllerDependencies } from './videos.controller.types.js';
import {
  toCreateVideoResponse,
  toMyVideosResponse,
  toSignedVideoUploadPartsResponse,
  toVideoUploadSessionResponse,
} from './videos.responses.js';
import {
  VIDEO_HLS_CONTENT_TYPE,
  VIDEO_HLS_MASTER_CACHE_CONTROL,
  VIDEO_HLS_RENDITION_CACHE_CONTROL,
  VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL,
} from '../../services/videos/videoHls.js';

type InitUploadRequest = Request<VideoParams, unknown, InitVideoMultipartUploadBody>;
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
type ListMyVideosRequest = Request<unknown, unknown, unknown, ListMyVideosQuery>;
type HlsMasterRequest = Request<VideoHlsMasterParams>;
type HlsRenditionRequest = Request<VideoHlsRenditionParams>;
type HlsSegmentRequest = Request<VideoHlsSegmentParams>;

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

  const listMyVideos: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const listReq = req as ListMyVideosRequest;
      const { cursorCreatedAt, cursorId, limit } = listReq.query;
      const result = await videosService.listMyVideos({
        userId: authenticatedReq.user.id,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursorCreatedAt !== undefined && cursorId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                id: cursorId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toMyVideosResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const initMultipartUpload: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const videoReq = req as InitUploadRequest;
      const result = await videosService.initMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId: videoReq.params.videoId,
        sizeBytes: videoReq.body.sizeBytes,
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

  const getHlsMaster: RequestHandler = async (req, res, next) => {
    try {
      const hlsReq = req as HlsMasterRequest;
      const result = await videosService.getHlsMaster({
        publicId: hlsReq.params.publicId,
      });

      return res
        .status(200)
        .set('Cache-Control', VIDEO_HLS_MASTER_CACHE_CONTROL)
        .set('Content-Type', VIDEO_HLS_CONTENT_TYPE)
        .send(result.playlist);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getHlsRendition: RequestHandler = async (req, res, next) => {
    try {
      const hlsReq = req as HlsRenditionRequest;
      const result = await videosService.getHlsRendition({
        publicId: hlsReq.params.publicId,
        generationId: hlsReq.params.generationId,
        quality: hlsReq.params.quality,
      });

      return res
        .status(200)
        .set('Cache-Control', VIDEO_HLS_RENDITION_CACHE_CONTROL)
        .set('Content-Type', VIDEO_HLS_CONTENT_TYPE)
        .send(result.playlist);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getHlsSegment: RequestHandler = async (req, res, next) => {
    try {
      const hlsReq = req as HlsSegmentRequest;
      const result = await videosService.getHlsSegment({
        publicId: hlsReq.params.publicId,
        generationId: hlsReq.params.generationId,
        quality: hlsReq.params.quality,
        segment: hlsReq.params.segment,
      });

      return res
        .set('Cache-Control', VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL)
        .redirect(307, result.url);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  return {
    abortMultipartUpload,
    completeMultipartUpload,
    createVideo,
    getHlsMaster,
    getHlsRendition,
    getHlsSegment,
    getMultipartUploadSession,
    initMultipartUpload,
    listMyVideos,
    signMultipartUploadParts,
  };
};
