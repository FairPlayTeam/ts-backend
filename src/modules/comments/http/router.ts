import { Router, type RequestHandler } from 'express';
import { createRouteProtector } from '../../../middleware/routeProtection.js';
import { createOptionalAuthenticateSession } from '../../../middleware/auth.js';
import { validate } from '../../../middleware/validation.js';
import type { AuthSessionValidationPort } from '../../../services/auth.types.js';
import type { CommentsPort } from '../types.js';
import { createCommentsHandlers } from './handlers.js';
import * as schemas from './schemas.js';

type CommentsRouterDependencies = {
  authService: AuthSessionValidationPort;
  commentsService: CommentsPort;
  videoCommentMutationLimiter: RequestHandler;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  authService,
  videoCommentMutationLimiter,
  commentsService,
}: CommentsRouterDependencies) => {
  const router = Router();
  const handlers = createCommentsHandlers({ commentsService });
  const protect = createRouteProtector({ authService });
  const optionalAuthenticate = createOptionalAuthenticateSession({ authService });
  const mutationRoute = (schema: ValidationSchema, handler: RequestHandler) => [
    ...protect(),
    validate(schema),
    videoCommentMutationLimiter,
    handler,
  ];
  const commentPath = '/:publicId/comments';
  const repliesPath = `${commentPath}/:rootCommentId/replies`;
  const commentByIdPath = `${commentPath}/:commentId`;
  const commentLikePath = `${commentByIdPath}/like`;

  router
    .route(commentPath)
    .get(validate(schemas.listCommentsSchema), optionalAuthenticate, handlers.listComments)
    .post(...mutationRoute(schemas.createCommentSchema, handlers.createComment));
  router
    .route(repliesPath)
    .get(validate(schemas.listRepliesSchema), optionalAuthenticate, handlers.listReplies)
    .post(...mutationRoute(schemas.createReplySchema, handlers.createReply));
  router.delete(
    commentByIdPath,
    ...mutationRoute(schemas.deleteCommentSchema, handlers.deleteComment),
  );
  router
    .route(commentLikePath)
    .put(...mutationRoute(schemas.mutateCommentLikeSchema, handlers.likeComment))
    .delete(...mutationRoute(schemas.mutateCommentLikeSchema, handlers.unlikeComment));

  return router;
};

export { routeDocs } from './openapi.js';
