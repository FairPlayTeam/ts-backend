import { Router, type RequestHandler } from 'express';
import { createVideosController } from '../controllers/videos.controller.js';
import {
  abortVideoMultipartUploadSchema,
  completeVideoMultipartUploadSchema,
  createVideoSchema,
  getVideoMultipartUploadSessionSchema,
  initVideoMultipartUploadSchema,
  listMyVideosSchema,
  signVideoMultipartUploadPartsSchema,
} from '../controllers/videos.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
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
    abortMultipartUpload,
    completeMultipartUpload,
    createVideo,
    getMultipartUploadSession,
    initMultipartUpload,
    listMyVideos,
    signMultipartUploadParts,
  } = createVideosController({ videosService });
  const protect = createRouteProtector({ authService });
  const protectedValidatedRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect(),
    validate(schema),
    ...handlers,
  ];

  router.post('/', ...protectedValidatedRoute(createVideoSchema, createVideo));
  router.get('/me', ...protectedValidatedRoute(listMyVideosSchema, listMyVideos));
  router.post(
    '/:videoId/upload/multipart/init',
    ...protectedValidatedRoute(initVideoMultipartUploadSchema, initMultipartUpload),
  );
  router.post(
    '/:videoId/upload/multipart/:uploadSessionId/parts/sign',
    ...protectedValidatedRoute(signVideoMultipartUploadPartsSchema, signMultipartUploadParts),
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
