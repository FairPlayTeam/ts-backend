import type { Request, RequestHandler } from 'express';
import { allowPublicCrossOriginMedia, sendNoStoreJson, setNoStore } from '../http.responses.js';
import { toVideosHttpError } from '../videos.errors.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { OptionallyAuthenticatedRequest } from '../../middleware/auth.js';
import type {
  CreateVideoBody,
  ListMyVideosQuery,
  ListPublicVideosQuery,
  PublicVideoIdParams,
  RateVideoBody,
  SearchPublicVideosQuery,
  VideoHlsRenditionParams,
  VideoHlsSegmentParams,
  VideoRatingParams,
  VideoThumbnailParams,
} from '../videos.schemas.js';
import type { VideosControllerDependencies } from './videos.controller.types.js';
import {
  toCreateVideoResponse,
  toMyVideosResponse,
  toPublicVideoDetailResponse,
  toPublicVideoSearchResponse,
  toPublicVideosResponse,
} from './videos.responses.js';
import {
  VIDEO_HLS_CONTENT_TYPE,
  VIDEO_HLS_MASTER_CACHE_CONTROL,
  VIDEO_HLS_RENDITION_CACHE_CONTROL,
  VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL,
  VIDEO_THUMBNAIL_REDIRECT_CACHE_CONTROL,
} from '../../services/videos/videoHls.js';

type CreateVideoRequest = Request<unknown, unknown, CreateVideoBody>;
type ListMyVideosRequest = Request<unknown, unknown, unknown, ListMyVideosQuery>;
type ListPublicVideosRequest = Request<unknown, unknown, unknown, ListPublicVideosQuery>;
type SearchPublicVideosRequest = Request<unknown, unknown, unknown, SearchPublicVideosQuery>;
type PublicVideoDetailRequest = Request<PublicVideoIdParams>;
type DeleteVideoRequest = Request<PublicVideoIdParams>;
type RateVideoRequest = Request<VideoRatingParams, unknown, RateVideoBody>;
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
        generationToken: hlsReq.params.generationToken,
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
        generationToken: hlsReq.params.generationToken,
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
    createVideo,
    deleteVideo,
    getHlsMaster,
    getHlsRendition,
    getHlsSegment,
    getPublicVideoDetail,
    getMyVideoRating,
    getThumbnail,
    getVideoRating,
    listPublicVideos,
    listMyVideos,
    rateVideo,
    searchPublicVideos,
  };
};
