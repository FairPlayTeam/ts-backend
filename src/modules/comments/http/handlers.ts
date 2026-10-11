import type { Request, RequestHandler } from 'express';
import type {
  AuthenticatedRequest,
  OptionallyAuthenticatedRequest,
} from '../../../middleware/auth.js';
import { sendNoStoreJson, setNoStore } from '../../../controllers/http.responses.js';
import { mapHandlerErrors } from '../../../shared/http/mapHandlerErrors.js';
import type { CommentsPort } from '../types.js';
import { toCommentsHttpError } from './errorMapper.js';
import {
  toCommentRepliesResponse,
  toCommentsResponse,
  toCreateCommentResponse,
} from './responses.js';
import type {
  CommentParams,
  CommentReplyParams,
  CreateCommentBody,
  CreateReplyBody,
  ListCommentsQuery,
  PublicVideoIdParams,
} from './schemas.js';

type CommentsHandlersDependencies = {
  commentsService: CommentsPort;
};

type CreateCommentRequest = Request<PublicVideoIdParams, unknown, CreateCommentBody>;
type CreateReplyRequest = Request<CommentReplyParams, unknown, CreateReplyBody>;
type ListCommentsRequest = Request<PublicVideoIdParams, unknown, unknown, ListCommentsQuery>;
type ListRepliesRequest = Request<CommentReplyParams, unknown, unknown, ListCommentsQuery>;
type CommentRequest = Request<CommentParams>;

export const createCommentsHandlers = ({ commentsService }: CommentsHandlersDependencies) => {
  const createComment: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const commentReq = req as CreateCommentRequest;
    const result = await commentsService.createComment({
      publicId: commentReq.params.publicId,
      userId: authenticatedReq.user.id,
      content: commentReq.body.content,
    });

    return sendNoStoreJson(res, 201, toCreateCommentResponse(result));
  });

  const createReply: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const commentReq = req as CreateReplyRequest;
    const result = await commentsService.createReply({
      publicId: commentReq.params.publicId,
      userId: authenticatedReq.user.id,
      rootCommentId: commentReq.params.rootCommentId,
      content: commentReq.body.content,
      ...(commentReq.body.replyingToCommentId === undefined
        ? {}
        : { replyingToCommentId: commentReq.body.replyingToCommentId }),
    });

    return sendNoStoreJson(res, 201, toCreateCommentResponse(result));
  });

  const listComments: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const optionallyAuthenticatedReq = req as OptionallyAuthenticatedRequest;
    const commentReq = req as ListCommentsRequest;
    const { cursorCreatedAt, cursorId, limit } = commentReq.query;
    const result = await commentsService.listComments({
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

    return sendNoStoreJson(res, 200, toCommentsResponse(result));
  });

  const listReplies: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const optionallyAuthenticatedReq = req as OptionallyAuthenticatedRequest;
    const commentReq = req as ListRepliesRequest;
    const { cursorCreatedAt, cursorId, limit } = commentReq.query;
    const result = await commentsService.listReplies({
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

    return sendNoStoreJson(res, 200, toCommentRepliesResponse(result));
  });

  const deleteComment: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const commentReq = req as CommentRequest;
    await commentsService.deleteComment({
      publicId: commentReq.params.publicId,
      commentId: commentReq.params.commentId,
      userId: authenticatedReq.user.id,
      actorRole: authenticatedReq.user.role,
    });

    return setNoStore(res).status(204).send();
  });

  const likeComment: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const commentReq = req as CommentRequest;
    await commentsService.likeComment({
      publicId: commentReq.params.publicId,
      commentId: commentReq.params.commentId,
      userId: authenticatedReq.user.id,
    });

    return setNoStore(res).status(204).send();
  });

  const unlikeComment: RequestHandler = mapHandlerErrors(toCommentsHttpError, async (req, res) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const commentReq = req as CommentRequest;
    await commentsService.unlikeComment({
      publicId: commentReq.params.publicId,
      commentId: commentReq.params.commentId,
      userId: authenticatedReq.user.id,
    });

    return setNoStore(res).status(204).send();
  });

  return {
    createComment,
    createReply,
    deleteComment,
    likeComment,
    listComments,
    listReplies,
    unlikeComment,
  };
};
