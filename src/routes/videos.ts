import { Router, type RequestHandler } from 'express';
import { createVideosController } from '../controllers/videos.controller.js';
import {
  abortVideoMultipartUploadSchema,
  completeVideoMultipartUploadSchema,
  createVideoSchema,
  getPublicVideoDetailSchema,
  getVideoMultipartUploadSessionSchema,
  getVideoRatingSchema,
  initVideoMultipartUploadSchema,
  listMyVideosSchema,
  listPublicVideosSchema,
  rateVideoSchema,
  searchPublicVideosSchema,
  signVideoMultipartUploadPartsSchema,
  uploadVideoSourceThumbnailSchema,
} from '../controllers/videos.schemas.js';
import { createSingleFileUpload } from '../middleware/upload.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { createOptionalAuthenticateSession } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import type { VideosRoutePort } from '../services/videos.types.js';

type VideosRouterDependencies = {
  authService: AuthSessionValidationPort;
  videosService: VideosRoutePort;
  profileMediaMaxUploadBytes: number;
  profileMediaUploadLimiter: RequestHandler;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  profileMediaUploadLimiter,
  videosService,
}: VideosRouterDependencies) => {
  const router = Router();
  const {
    abortMultipartUpload,
    completeMultipartUpload,
    createVideo,
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
    rateVideo,
    searchPublicVideos,
    signMultipartUploadParts,
    uploadSourceThumbnail,
  } = createVideosController({ videosService });
  const protect = createRouteProtector({ authService });
  const optionalAuthenticate = createOptionalAuthenticateSession({ authService });
  const uploadThumbnailFile = createSingleFileUpload({
    fieldName: 'thumbnail',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });
  const protectedValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect(),
    validate(schema),
    ...handlers,
  ];

  router.post('/', ...protectedValidatedRoute(createVideoSchema, createVideo));
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
  router.get('/:publicId/hls/:generationId/:quality/index.m3u8', getHlsRendition);
  router.get('/:publicId/hls/:generationId/:quality/segments/:segment', getHlsSegment);
  router.post(
    '/:videoId/upload/multipart/init',
    ...protectedValidatedRoute(initVideoMultipartUploadSchema, initMultipartUpload),
  );
  router.post(
    '/:videoId/upload/multipart/:uploadSessionId/parts/sign',
    ...protectedValidatedRoute(signVideoMultipartUploadPartsSchema, signMultipartUploadParts),
  );
  router.put(
    '/:videoId/upload/multipart/:uploadSessionId/thumbnail',
    ...protectedValidatedRoute(
      uploadVideoSourceThumbnailSchema,
      profileMediaUploadLimiter,
      uploadThumbnailFile,
      uploadSourceThumbnail,
    ),
  );
  router.post(
    '/:videoId/upload/multipart/:uploadSessionId/complete',
    ...protectedValidatedRoute(completeVideoMultipartUploadSchema, completeMultipartUpload),
  );
  router.post(
    '/:videoId/upload/multipart/:uploadSessionId/abort',
    ...protectedValidatedRoute(abortVideoMultipartUploadSchema, abortMultipartUpload),
  );
  router.get(
    '/:videoId/upload/multipart/:uploadSessionId',
    ...protectedValidatedRoute(getVideoMultipartUploadSessionSchema, getMultipartUploadSession),
  );

  return router;
};

export { routeDocs } from '../docs/videos.routes.js';
