import { Router, type RequestHandler } from 'express';
import { createVideosController } from './handlers.js';
import {
  createVideoSchema,
  deleteVideoSchema,
  getPublicVideoDetailSchema,
  getVideoRatingSchema,
  getVideoHlsRenditionSchema,
  getVideoHlsSegmentSchema,
  listMyVideosSchema,
  listPublicVideosSchema,
  rateVideoSchema,
  searchPublicVideosSchema,
} from './schemas.js';
import { createRouteProtector } from '../../../middleware/routeProtection.js';
import { createOptionalAuthenticateSession } from '../../../middleware/auth.js';
import { validate } from '../../../middleware/validation.js';
import type { AuthSessionValidationPort } from '../../../services/auth.types.js';
import type { VideosRoutePort } from '../types.js';

type VideosRouterDependencies = {
  authService: AuthSessionValidationPort;
  videosService: VideosRoutePort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({ authService, videosService }: VideosRouterDependencies) => {
  const router = Router();
  const {
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
  } = createVideosController({ videosService });
  const protect = createRouteProtector({ authService });
  const optionalAuthenticate = createOptionalAuthenticateSession({ authService });
  const protectedValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect(),
    validate(schema),
    ...handlers,
  ];

  router.post('/', ...protectedValidatedRoute(createVideoSchema, createVideo));
  router.delete('/:publicId', ...protectedValidatedRoute(deleteVideoSchema, deleteVideo));
  router.get('/', validate(listPublicVideosSchema), listPublicVideos);
  router.get('/me', ...protectedValidatedRoute(listMyVideosSchema, listMyVideos));
  router.get('/search', validate(searchPublicVideosSchema), searchPublicVideos);
  router.get(
    '/:publicId',
    validate(getPublicVideoDetailSchema),
    optionalAuthenticate,
    getPublicVideoDetail,
  );
  router.get(
    '/:publicId/rating/me',
    ...protectedValidatedRoute(getVideoRatingSchema, getMyVideoRating),
  );
  router.get('/:publicId/rating', validate(getVideoRatingSchema), getVideoRating);
  router.put('/:publicId/rating', ...protectedValidatedRoute(rateVideoSchema, rateVideo));
  router.get('/:publicId/thumbnail', validate(getPublicVideoDetailSchema), getThumbnail);
  router.get('/:publicId/hls/master.m3u8', validate(getPublicVideoDetailSchema), getHlsMaster);
  router.get(
    '/:publicId/hls/:generationToken/:quality/index.m3u8',
    validate(getVideoHlsRenditionSchema),
    getHlsRendition,
  );
  router.get(
    '/:publicId/hls/:generationToken/:quality/segments/:segment',
    validate(getVideoHlsSegmentSchema),
    getHlsSegment,
  );
  return router;
};

export { routeDocs } from './openapi.js';
