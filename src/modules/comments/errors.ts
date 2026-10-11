export const COMMENT_NOT_FOUND_MESSAGE = 'Comment not found';
export const COMMENTS_DISABLED_MESSAGE = 'Comments are disabled for this video';
export const COMMENTS_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Video comments are temporarily unavailable; please retry';

export class CommentNotFoundError extends Error {
  constructor() {
    super(COMMENT_NOT_FOUND_MESSAGE);
    this.name = 'CommentNotFoundError';
  }
}

export class CommentsDisabledError extends Error {
  constructor() {
    super(COMMENTS_DISABLED_MESSAGE);
    this.name = 'CommentsDisabledError';
  }
}

export class CommentsTemporarilyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(COMMENTS_TEMPORARILY_UNAVAILABLE_MESSAGE, options);
    this.name = 'CommentsTemporarilyUnavailableError';
  }
}
