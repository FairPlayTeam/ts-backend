import { Router, type RequestHandler } from 'express';
import { createVideosController } from '../controllers/videos.controller.js';
import {
  createVideoSchema,
  deleteVideoSchema,
  getPublicVideoDetailSchema,
  getVideoRatingSchema,
  listMyVideosSchema,
  listPublicVideosSchema,
  rateVideoSchema,
  searchPublicVideosSchema,
} from '../controllers/videos.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { createOptionalAuthenticateSession } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import type { VideosRoutePort } from '../services/videos.types.js';

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
  router.get('/:publicId/thumbnail', getThumbnail);
  router.get('/:publicId/hls/master.m3u8', getHlsMaster);
  router.get('/:publicId/hls/:generationToken/:quality/index.m3u8', getHlsRendition);
  router.get('/:publicId/hls/:generationToken/:quality/segments/:segment', getHlsSegment);
  return router;
};

export { routeDocs } from '../docs/videos.routes.js';
