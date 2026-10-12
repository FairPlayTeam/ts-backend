import { Router, type RequestHandler } from 'express';
import { createSingleFileUpload } from '../../../middleware/upload.js';
import { createRouteProtector } from '../../../middleware/routeProtection.js';
import { validate } from '../../../middleware/validation.js';
import type { AuthSessionValidationPort } from '../../auth/index.js';
import type { VideoUploadsPort } from '../types.js';
import { createVideoUploadsHandlers } from './handlers.js';
import * as schemas from './schemas.js';

type VideoUploadsRouterDependencies = {
  authService: AuthSessionValidationPort;
  videoUploadsService: VideoUploadsPort;
  profileMediaMaxUploadBytes: number;
  profileMediaUploadLimiter: RequestHandler;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  authService,
  profileMediaMaxUploadBytes,
  profileMediaUploadLimiter,
  videoUploadsService,
}: VideoUploadsRouterDependencies) => {
  const router = Router();
  const handlers = createVideoUploadsHandlers({ videoUploadsService });
  const protect = createRouteProtector({ authService });
  const uploadThumbnailFile = createSingleFileUpload({
    fieldName: 'thumbnail',
    maxFileSizeBytes: profileMediaMaxUploadBytes,
  });
  const protectedValidatedRoute = (
    schema: ValidationSchema,
    ...routeHandlers: RequestHandler[]
  ) => [...protect(), validate(schema), ...routeHandlers];

  router.post(
    '/:publicId/upload/multipart/init',
    ...protectedValidatedRoute(
      schemas.initVideoMultipartUploadSchema,
      handlers.initMultipartUpload,
    ),
  );
  router.post(
    '/:publicId/upload/multipart/:uploadSessionId/parts/sign',
    ...protectedValidatedRoute(
      schemas.signVideoMultipartUploadPartsSchema,
      handlers.signMultipartUploadParts,
    ),
  );
  router.put(
    '/:publicId/upload/multipart/:uploadSessionId/thumbnail',
    ...protectedValidatedRoute(
      schemas.uploadVideoSourceThumbnailSchema,
      profileMediaUploadLimiter,
      uploadThumbnailFile,
      handlers.uploadSourceThumbnail,
    ),
  );
  router.post(
    '/:publicId/upload/multipart/:uploadSessionId/complete',
    ...protectedValidatedRoute(
      schemas.completeVideoMultipartUploadSchema,
      handlers.completeMultipartUpload,
    ),
  );
  router.post(
    '/:publicId/upload/multipart/:uploadSessionId/abort',
    ...protectedValidatedRoute(
      schemas.abortVideoMultipartUploadSchema,
      handlers.abortMultipartUpload,
    ),
  );
  router.get(
    '/:publicId/upload/multipart/:uploadSessionId',
    ...protectedValidatedRoute(
      schemas.getVideoMultipartUploadSessionSchema,
      handlers.getMultipartUploadSession,
    ),
  );

  return router;
};
