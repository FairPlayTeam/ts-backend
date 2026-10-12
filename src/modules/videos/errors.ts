export const VIDEO_DELETION_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Video deletion is temporarily unavailable; please retry';
export const VIDEO_SELF_RATING_FORBIDDEN_MESSAGE = 'Video owners cannot rate their own videos';
export const VIDEO_RATING_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Video rating is temporarily unavailable; please retry';

export class VideoDeletionTemporarilyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(VIDEO_DELETION_TEMPORARILY_UNAVAILABLE_MESSAGE, options);
    this.name = 'VideoDeletionTemporarilyUnavailableError';
  }
}

export class VideoSelfRatingForbiddenError extends Error {
  constructor() {
    super(VIDEO_SELF_RATING_FORBIDDEN_MESSAGE);
    this.name = 'VideoSelfRatingForbiddenError';
  }
}

export class VideoRatingTemporarilyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(VIDEO_RATING_TEMPORARILY_UNAVAILABLE_MESSAGE, options);
    this.name = 'VideoRatingTemporarilyUnavailableError';
  }
}
