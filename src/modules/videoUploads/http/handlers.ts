import type { Request, RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';
import { sendNoStoreJson } from '../../../controllers/http.responses.js';
import { mapHandlerErrors } from '../../../shared/http/mapHandlerErrors.js';
import type { VideoUploadsPort } from '../types.js';
import { toVideoUploadsHttpError } from './errorMapper.js';
import {
  toSignedVideoUploadPartsResponse,
  toUploadVideoSourceThumbnailResponse,
  toVideoUploadSessionResponse,
} from './responses.js';
import type {
  CompleteVideoMultipartUploadBody,
  InitVideoMultipartUploadBody,
  SignVideoMultipartUploadPartsBody,
  VideoMultipartUploadSessionParams,
  VideoParams,
} from './schemas.js';

type VideoUploadsHandlersDependencies = {
  videoUploadsService: VideoUploadsPort;
};

type InitUploadRequest = Request<VideoParams, unknown, InitVideoMultipartUploadBody>;
type SessionRequest = Request<VideoMultipartUploadSessionParams>;
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

export const createVideoUploadsHandlers = ({
  videoUploadsService,
}: VideoUploadsHandlersDependencies) => {
  const initMultipartUpload: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const uploadReq = req as InitUploadRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: uploadReq.params.publicId,
      });
      const result = await videoUploadsService.initMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId,
        sizeBytes: uploadReq.body.sizeBytes,
      });

      return sendNoStoreJson(
        res,
        201,
        toVideoUploadSessionResponse(result, uploadReq.params.publicId),
      );
    },
  );

  const signMultipartUploadParts: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const signReq = req as SignPartsRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: signReq.params.publicId,
      });
      const result = await videoUploadsService.signMultipartUploadParts({
        userId: authenticatedReq.user.id,
        videoId,
        uploadSessionId: signReq.params.uploadSessionId,
        partNumbers: signReq.body.partNumbers,
      });

      return sendNoStoreJson(res, 200, toSignedVideoUploadPartsResponse(result));
    },
  );

  const uploadSourceThumbnail: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const sessionReq = req as SessionRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: sessionReq.params.publicId,
      });
      const result = await videoUploadsService.uploadSourceThumbnail({
        userId: authenticatedReq.user.id,
        videoId,
        uploadSessionId: sessionReq.params.uploadSessionId,
        file: req.file
          ? {
              buffer: req.file.buffer,
              size: req.file.size,
            }
          : {
              buffer: Buffer.alloc(0),
              size: 0,
            },
      });

      return sendNoStoreJson(res, 200, toUploadVideoSourceThumbnailResponse(result));
    },
  );

  const completeMultipartUpload: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const completeReq = req as CompleteRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: completeReq.params.publicId,
      });
      const result = await videoUploadsService.completeMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId,
        uploadSessionId: completeReq.params.uploadSessionId,
        parts: completeReq.body.parts,
      });

      return sendNoStoreJson(
        res,
        200,
        toVideoUploadSessionResponse(result, completeReq.params.publicId),
      );
    },
  );

  const abortMultipartUpload: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const sessionReq = req as SessionRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: sessionReq.params.publicId,
      });
      const result = await videoUploadsService.abortMultipartUpload({
        userId: authenticatedReq.user.id,
        videoId,
        uploadSessionId: sessionReq.params.uploadSessionId,
      });

      return sendNoStoreJson(
        res,
        200,
        toVideoUploadSessionResponse(result, sessionReq.params.publicId),
      );
    },
  );

  const getMultipartUploadSession: RequestHandler = mapHandlerErrors(
    toVideoUploadsHttpError,
    async (req, res) => {
      const authenticatedReq = req as AuthenticatedRequest;
      const sessionReq = req as SessionRequest;
      const videoId = await videoUploadsService.resolveOwnedVideoId({
        userId: authenticatedReq.user.id,
        publicId: sessionReq.params.publicId,
      });
      const result = await videoUploadsService.getMultipartUploadSession({
        userId: authenticatedReq.user.id,
        videoId,
        uploadSessionId: sessionReq.params.uploadSessionId,
      });

      return sendNoStoreJson(
        res,
        200,
        toVideoUploadSessionResponse(result, sessionReq.params.publicId),
      );
    },
  );

  return {
    abortMultipartUpload,
    completeMultipartUpload,
    getMultipartUploadSession,
    initMultipartUpload,
    signMultipartUploadParts,
    uploadSourceThumbnail,
  };
};
