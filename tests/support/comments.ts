import type {
  CommentsPort,
  CreateCommentResult,
  ListCommentsResult,
  ListRepliesResult,
} from '../../src/modules/comments/index.js';

const fixedNow = new Date('2026-01-01T00:00:00.000Z');

const listCommentsResult = (): ListCommentsResult => ({
  comments: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      publicId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
      content: 'This is the first FairPlay video.',
      isDeleted: false,
      createdAt: fixedNow,
      rootCommentId: null,
      rootCommentPublicId: null,
      likeCount: 0,
      viewerHasLiked: false,
      replyingTo: null,
      author: {
        username: 'fairplay_user',
        displayName: 'FairPlay User',
        avatarUrl: null,
      },
      replyCount: 1,
    },
  ],
  total: 1,
  nextCursor: null,
});

const listRepliesResult = (): ListRepliesResult => ({
  replies: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      publicId: 'c_0d4e55cbc2784d74a192bf7c10888c7b',
      content: 'A reply.',
      isDeleted: false,
      createdAt: fixedNow,
      rootCommentId: '11111111-1111-4111-8111-111111111111',
      rootCommentPublicId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
      likeCount: 0,
      viewerHasLiked: false,
      replyingTo: {
        commentId: '11111111-1111-4111-8111-111111111111',
        publicCommentId: 'c_0d4e55cbc2784d74a192bf7c10888c7a',
        username: 'fairplay_user',
      },
      author: {
        username: 'jawed',
        displayName: 'Jawed Karim',
        avatarUrl: null,
      },
    },
  ],
  total: 1,
  nextCursor: null,
});

const createdComment = (input: {
  content: string;
  rootCommentId?: string;
  replyingToCommentId?: string;
}): CreateCommentResult => ({
  comment: {
    id: input.rootCommentId
      ? '22222222-2222-4222-8222-222222222222'
      : '11111111-1111-4111-8111-111111111111',
    publicId: input.rootCommentId
      ? 'c_0d4e55cbc2784d74a192bf7c10888c7b'
      : 'c_0d4e55cbc2784d74a192bf7c10888c7a',
    content: input.content,
    isDeleted: false,
    createdAt: fixedNow,
    rootCommentId: input.rootCommentId ?? null,
    rootCommentPublicId: input.rootCommentId ?? null,
    likeCount: 0,
    viewerHasLiked: false,
    replyingTo: input.rootCommentId
      ? {
          commentId: input.replyingToCommentId ?? input.rootCommentId,
          publicCommentId: input.replyingToCommentId ?? input.rootCommentId,
          username: 'jawed',
        }
      : null,
    author: {
      username: 'fairplay_user',
      displayName: 'FairPlay User',
      avatarUrl: null,
    },
  },
});

export const createStubCommentsService = (): CommentsPort => ({
  createComment: async (input) => createdComment(input),
  createReply: async (input) => createdComment(input),
  listComments: async () => listCommentsResult(),
  listReplies: async () => listRepliesResult(),
  deleteComment: async () => undefined,
  likeComment: async () => undefined,
  unlikeComment: async () => undefined,
});
