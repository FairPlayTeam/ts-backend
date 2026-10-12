import type { AuthRole } from '../auth/roles.js';
import type { PublicProfileIdentity } from '../profiles/types.js';

export type CommentAuthor = PublicProfileIdentity;

type CommentBase = {
  id: string;
  createdAt: Date;
  rootCommentId: string | null;
  likeCount: number;
  viewerHasLiked: boolean;
};

export type ActiveComment = CommentBase & {
  content: string;
  isDeleted: false;
  replyingTo: {
    commentId: string;
    username: string;
  } | null;
  author: CommentAuthor;
};

export type DeletedCommentPlaceholder = CommentBase & {
  content: null;
  isDeleted: true;
  rootCommentId: null;
  replyingTo: null;
  author: null;
};

export type Comment = ActiveComment | DeletedCommentPlaceholder;

export type CommentRoot = Comment & {
  rootCommentId: null;
  replyCount: number;
};

export type CommentReply = ActiveComment & {
  rootCommentId: string;
};

export type CommentCursor = {
  createdAt: Date;
  id: string;
};

export type CreateCommentInput = {
  publicId: string;
  userId: string;
  content: string;
};

export type CreateReplyInput = CreateCommentInput & {
  rootCommentId: string;
  replyingToCommentId?: string;
};

export type CreateCommentResult = {
  comment: ActiveComment;
};

export type ListCommentsInput = {
  publicId: string;
  viewerUserId?: string;
  cursor?: CommentCursor;
  limit?: number;
};

export type ListRepliesInput = ListCommentsInput & {
  rootCommentId: string;
};

export type ListCommentsResult = {
  comments: CommentRoot[];
  total: number;
  nextCursor: CommentCursor | null;
};

export type ListRepliesResult = {
  replies: CommentReply[];
  total: number;
  nextCursor: CommentCursor | null;
};

export type DeleteCommentInput = {
  publicId: string;
  commentId: string;
  userId: string;
  actorRole: AuthRole;
};

export type MutateCommentLikeInput = {
  publicId: string;
  commentId: string;
  userId: string;
};

export type CommentsPort = {
  createComment(input: CreateCommentInput): Promise<CreateCommentResult>;
  createReply(input: CreateReplyInput): Promise<CreateCommentResult>;
  listComments(input: ListCommentsInput): Promise<ListCommentsResult>;
  listReplies(input: ListRepliesInput): Promise<ListRepliesResult>;
  deleteComment(input: DeleteCommentInput): Promise<void>;
  likeComment(input: MutateCommentLikeInput): Promise<void>;
  unlikeComment(input: MutateCommentLikeInput): Promise<void>;
};
