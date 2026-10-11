import { toIsoString } from '../../../controllers/http.responses.js';
import { toPublicProfileIdentityResponse } from '../../../controllers/shared/profile.responses.js';
import type {
  Comment,
  CreateCommentResult,
  ListCommentsResult,
  ListRepliesResult,
} from '../types.js';

const toCommentResponseBody = (comment: Comment) =>
  comment.isDeleted
    ? {
        id: comment.id,
        content: null,
        isDeleted: true as const,
        createdAt: toIsoString(comment.createdAt),
        rootCommentId: null,
        likeCount: comment.likeCount,
        viewerHasLiked: comment.viewerHasLiked,
        replyingTo: null,
        author: null,
      }
    : {
        id: comment.id,
        content: comment.content,
        isDeleted: comment.isDeleted,
        createdAt: toIsoString(comment.createdAt),
        rootCommentId: comment.rootCommentId,
        likeCount: comment.likeCount,
        viewerHasLiked: comment.viewerHasLiked,
        replyingTo: comment.replyingTo
          ? {
              commentId: comment.replyingTo.commentId,
              username: comment.replyingTo.username,
            }
          : null,
        author: toPublicProfileIdentityResponse(comment.author),
      };

const toCommentCursorResponse = (cursor: ListCommentsResult['nextCursor']) =>
  cursor
    ? {
        id: cursor.id,
        createdAt: toIsoString(cursor.createdAt),
      }
    : null;

export const toCreateCommentResponse = ({ comment }: CreateCommentResult) => ({
  comment: toCommentResponseBody(comment),
});

export const toCommentsResponse = ({ comments, nextCursor, total }: ListCommentsResult) => ({
  comments: comments.map((comment) => ({
    ...toCommentResponseBody(comment),
    replyCount: comment.replyCount,
  })),
  total,
  nextCursor: toCommentCursorResponse(nextCursor),
});

export const toCommentRepliesResponse = ({ nextCursor, replies, total }: ListRepliesResult) => ({
  replies: replies.map(toCommentResponseBody),
  total,
  nextCursor: toCommentCursorResponse(nextCursor),
});
