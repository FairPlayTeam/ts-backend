import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { allowPublicCrossOriginMedia, sendNoStoreJson, setNoStore } from '../http.responses.js';
import { toVideosHttpError } from '../videos.errors.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { OptionallyAuthenticatedRequest } from '../../middleware/auth.js';
import type {
  CompleteVideoMultipartUploadBody,
  CreateVideoCommentBody,
  CreateVideoCommentReplyBody,
  CreateVideoBody,
  InitVideoMultipartUploadBody,
  ListMyVideosQuery,
  ListPublicVideosQuery,
  ListVideoCommentsQuery,
  PublicVideoIdParams,
  RateVideoBody,
  SearchPublicVideosQuery,
  SignVideoMultipartUploadPartsBody,
  VideoHlsRenditionParams,
  VideoHlsSegmentParams,
  VideoMultipartUploadSessionParams,
  VideoParams,
  VideoRatingParams,
  VideoCommentReplyParams,
  VideoCommentParams,
  VideoThumbnailParams,
} from '../videos.schemas.js';
import type { VideosControllerDependencies } from './videos.controller.types.js';
import {
  toCreateVideoResponse,
  toMyVideosResponse,
  toPublicVideoDetailResponse,
  toPublicVideoSearchResponse,
  toPublicVideosResponse,
  toSignedVideoUploadPartsResponse,
  toUploadVideoSourceThumbnailResponse,
  toVideoUploadSessionResponse,
  toVideoCommentResponse,
  toVideoCommentRepliesResponse,
  toVideoCommentsResponse,
} from './videos.responses.js';
import {
  VIDEO_HLS_CONTENT_TYPE,
  VIDEO_HLS_MASTER_CACHE_CONTROL,
  VIDEO_HLS_RENDITION_CACHE_CONTROL,
  VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL,
  VIDEO_THUMBNAIL_REDIRECT_CACHE_CONTROL,
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
type ListPublicVideosRequest = Request<unknown, unknown, unknown, ListPublicVideosQuery>;
type SearchPublicVideosRequest = Request<unknown, unknown, unknown, SearchPublicVideosQuery>;
type PublicVideoDetailRequest = Request<PublicVideoIdParams>;
type DeleteVideoRequest = Request<PublicVideoIdParams>;
type RateVideoRequest = Request<VideoRatingParams, unknown, RateVideoBody>;
type CreateVideoCommentRequest = Request<PublicVideoIdParams, unknown, CreateVideoCommentBody>;
type CreateVideoCommentReplyRequest = Request<
  VideoCommentReplyParams,
  unknown,
  CreateVideoCommentReplyBody
>;
type ListVideoCommentsRequest = Request<
  PublicVideoIdParams,
  unknown,
  unknown,
  ListVideoCommentsQuery
>;
type ListVideoCommentRepliesRequest = Request<
  VideoCommentReplyParams,
  unknown,
  unknown,
  ListVideoCommentsQuery
>;
type DeleteVideoCommentRequest = Request<VideoCommentParams>;
type MutateVideoCommentLikeRequest = Request<VideoCommentParams>;
type HlsMasterRequest = Request<PublicVideoIdParams>;
type HlsRenditionRequest = Request<VideoHlsRenditionParams>;
type HlsSegmentRequest = Request<VideoHlsSegmentParams>;
type ThumbnailRequest = Request<VideoThumbnailParams>;

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
        allowComments: createReq.body.allowComments,
      });

      return sendNoStoreJson(res, 201, toCreateVideoResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const deleteVideo: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const deleteReq = req as DeleteVideoRequest;
      await videosService.deleteVideo({
        publicId: deleteReq.params.publicId,
        userId: authenticatedReq.user.id,
      });

      return setNoStore(res).status(204).send();
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const createVideoComment: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const commentReq = req as CreateVideoCommentRequest;
      const result = await videosService.createVideoComment({
        publicId: commentReq.params.publicId,
        userId: authenticatedReq.user.id,
        content: commentReq.body.content,
      });

      return sendNoStoreJson(res, 201, toVideoCommentResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const createVideoCommentReply: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const commentReq = req as CreateVideoCommentReplyRequest;
      const result = await videosService.createVideoCommentReply({
        publicId: commentReq.params.publicId,
        userId: authenticatedReq.user.id,
        rootCommentId: commentReq.params.rootCommentId,
        content: commentReq.body.content,
        ...(commentReq.body.replyingToCommentId === undefined
          ? {}
          : { replyingToCommentId: commentReq.body.replyingToCommentId }),
      });

      return sendNoStoreJson(res, 201, toVideoCommentResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const listVideoComments: RequestHandler = async (req, res, next) => {
    try {
      const optionallyAuthenticatedReq = req as OptionallyAuthenticatedRequest;
      const commentReq = req as ListVideoCommentsRequest;
      const { cursorCreatedAt, cursorId, limit } = commentReq.query;
      const result = await videosService.listVideoComments({
        publicId: commentReq.params.publicId,
        ...(optionallyAuthenticatedReq.user
          ? { viewerUserId: optionallyAuthenticatedReq.user.id }
          : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(cursorCreatedAt !== undefined && cursorId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                id: cursorId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toVideoCommentsResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const listVideoCommentReplies: RequestHandler = async (req, res, next) => {
    try {
      const optionallyAuthenticatedReq = req as OptionallyAuthenticatedRequest;
      const commentReq = req as ListVideoCommentRepliesRequest;
      const { cursorCreatedAt, cursorId, limit } = commentReq.query;
      const result = await videosService.listVideoCommentReplies({
        publicId: commentReq.params.publicId,
        rootCommentId: commentReq.params.rootCommentId,
        ...(optionallyAuthenticatedReq.user
          ? { viewerUserId: optionallyAuthenticatedReq.user.id }
          : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(cursorCreatedAt !== undefined && cursorId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                id: cursorId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toVideoCommentRepliesResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const deleteVideoComment: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const commentReq = req as DeleteVideoCommentRequest;
      await videosService.deleteVideoComment({
        publicId: commentReq.params.publicId,
        commentId: commentReq.params.commentId,
        userId: authenticatedReq.user.id,
        actorRole: authenticatedReq.user.role,
      });

      return setNoStore(res).status(204).send();
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const likeVideoComment: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const commentReq = req as MutateVideoCommentLikeRequest;
      await videosService.likeVideoComment({
        publicId: commentReq.params.publicId,
        commentId: commentReq.params.commentId,
        userId: authenticatedReq.user.id,
      });

      return setNoStore(res).status(204).send();
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const unlikeVideoComment: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const commentReq = req as MutateVideoCommentLikeRequest;
      await videosService.unlikeVideoComment({
        publicId: commentReq.params.publicId,
        commentId: commentReq.params.commentId,
        userId: authenticatedReq.user.id,
      });

      return setNoStore(res).status(204).send();
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

  const searchPublicVideos: RequestHandler = async (req, res, next) => {
    try {
      const searchReq = req as SearchPublicVideosRequest;
      const { cursorCreatedAt, cursorPublicId, limit, search, sort } = searchReq.query;
      const result = await videosService.searchPublicVideos({
        search,
        ...(limit === undefined ? {} : { limit }),
        ...(sort === undefined ? {} : { sort }),
        ...(cursorCreatedAt !== undefined && cursorPublicId !== undefined
          ? {
              cursor: {
                createdAt: new Date(cursorCreatedAt),
                publicId: cursorPublicId,
              },
            }
          : {}),
      });

      return sendNoStoreJson(res, 200, toPublicVideoSearchResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const listPublicVideos: RequestHandler = async (req, res, next) => {
    try {
      const listReq = req as ListPublicVideosRequest;
      const { cursorCreatedAt, cursorPublicId, limit } = listReq.query;
      const result = await videosService.listPublicVideos({
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
      next(toVideosHttpError(err));
    }
  };

  const getPublicVideoDetail: RequestHandler = async (req, res, next) => {
    try {
      const detailReq = req as PublicVideoDetailRequest;
      const optionallyAuthenticatedReq = req as OptionallyAuthenticatedRequest;
      const userId = optionallyAuthenticatedReq.user?.id;
      const result = await videosService.getPublicVideoDetail({
        publicId: detailReq.params.publicId,
        ...(userId === undefined ? {} : { userId }),
      });

      return sendNoStoreJson(res, 200, toPublicVideoDetailResponse(result));
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getVideoRating: RequestHandler = async (req, res, next) => {
    try {
      const videoReq = req as Request<VideoRatingParams>;
      const result = await videosService.getVideoRating({
        publicId: videoReq.params.publicId,
      });

      return sendNoStoreJson(res, 200, result);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getMyVideoRating: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const videoReq = req as Request<VideoRatingParams>;
      const result = await videosService.getMyVideoRating({
        userId: authenticatedReq.user.id,
        publicId: videoReq.params.publicId,
      });

      return sendNoStoreJson(res, 200, result);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const rateVideo: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const videoReq = req as RateVideoRequest;
      const result = await videosService.rateVideo({
        userId: authenticatedReq.user.id,
        publicId: videoReq.params.publicId,
        value: videoReq.body.value,
      });

      return sendNoStoreJson(res, 200, result);
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

  const uploadSourceThumbnail: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const thumbnailReq = req as VideoUploadSessionRequest;
      const result = await videosService.uploadSourceThumbnail({
        userId: authenticatedReq.user.id,
        videoId: thumbnailReq.params.videoId,
        uploadSessionId: thumbnailReq.params.uploadSessionId,
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

      return allowPublicCrossOriginMedia(res)
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

      return allowPublicCrossOriginMedia(res)
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

      return allowPublicCrossOriginMedia(res)
        .set('Cache-Control', VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL)
        .redirect(307, result.url);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  const getThumbnail: RequestHandler = async (req, res, next) => {
    try {
      const thumbnailReq = req as ThumbnailRequest;
      const result = await videosService.getThumbnail({
        publicId: thumbnailReq.params.publicId,
      });

      return allowPublicCrossOriginMedia(res)
        .set('Cache-Control', VIDEO_THUMBNAIL_REDIRECT_CACHE_CONTROL)
        .redirect(307, result.url);
    } catch (err) {
      next(toVideosHttpError(err));
    }
  };

  return {
    abortMultipartUpload,
    completeMultipartUpload,
    createVideo,
    createVideoComment,
    createVideoCommentReply,
    deleteVideo,
    deleteVideoComment,
    likeVideoComment,
    getHlsMaster,
    getHlsRendition,
    getHlsSegment,
    getMultipartUploadSession,
    getPublicVideoDetail,
    getMyVideoRating,
    getThumbnail,
    getVideoRating,
    initMultipartUpload,
    listPublicVideos,
    listMyVideos,
    listVideoCommentReplies,
    listVideoComments,
    rateVideo,
    searchPublicVideos,
    signMultipartUploadParts,
    uploadSourceThumbnail,
    unlikeVideoComment,
  };
};
