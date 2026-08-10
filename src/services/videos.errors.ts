export const VIDEO_NOT_FOUND_MESSAGE = 'Video not found';
export const VIDEO_SELF_RATING_FORBIDDEN_MESSAGE = 'Video owners cannot rate their own videos';
export const VIDEO_RATING_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Video rating is temporarily unavailable; please retry';
export const VIDEO_COMMENTS_DISABLED_MESSAGE = 'Comments are disabled for this video';
export const VIDEO_COMMENT_NOT_FOUND_MESSAGE = 'Comment not found';
export const VIDEO_COMMENT_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Video comments are temporarily unavailable; please retry';
export const VIDEO_UPLOAD_SESSION_NOT_FOUND_MESSAGE = 'Video upload session not found';
export const ACTIVE_VIDEO_UPLOAD_SESSION_EXISTS_MESSAGE =
  'An active upload session already exists for this video';
export const VIDEO_UPLOAD_SESSION_EXPIRED_MESSAGE = 'Video upload session expired';
export const VIDEO_UPLOAD_SESSION_STATE_MESSAGE = 'Video upload session is not in a valid state';
export const VIDEO_UPLOAD_STATE_MESSAGE = 'Video is not in a valid upload state';
const VIDEO_UPLOAD_SIZE_EXCEEDED_MESSAGE = 'Declared video size exceeds the upload limit';
const VIDEO_STORAGE_QUOTA_EXCEEDED_MESSAGE = 'Video storage quota exceeded';
const VIDEO_UPLOAD_SIZE_MISMATCH_MESSAGE = 'Uploaded video size does not match the declared size';

export class VideoNotFoundError extends Error {
  constructor() {
    super(VIDEO_NOT_FOUND_MESSAGE);
    this.name = 'VideoNotFoundError';
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

export class VideoCommentsDisabledError extends Error {
  constructor() {
    super(VIDEO_COMMENTS_DISABLED_MESSAGE);
    this.name = 'VideoCommentsDisabledError';
  }
}

export class VideoCommentNotFoundError extends Error {
  constructor() {
    super(VIDEO_COMMENT_NOT_FOUND_MESSAGE);
    this.name = 'VideoCommentNotFoundError';
  }
}

export class VideoCommentTemporarilyUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(VIDEO_COMMENT_TEMPORARILY_UNAVAILABLE_MESSAGE, options);
    this.name = 'VideoCommentTemporarilyUnavailableError';
  }
}

export class VideoUploadSessionNotFoundError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_SESSION_NOT_FOUND_MESSAGE);
    this.name = 'VideoUploadSessionNotFoundError';
  }
}

export class ActiveVideoUploadSessionExistsError extends Error {
  constructor() {
    super(ACTIVE_VIDEO_UPLOAD_SESSION_EXISTS_MESSAGE);
    this.name = 'ActiveVideoUploadSessionExistsError';
  }
}

export class VideoUploadSessionExpiredError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_SESSION_EXPIRED_MESSAGE);
    this.name = 'VideoUploadSessionExpiredError';
  }
}

export class InvalidVideoUploadSessionStateError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_SESSION_STATE_MESSAGE);
    this.name = 'InvalidVideoUploadSessionStateError';
  }
}

export class InvalidVideoUploadStateError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_STATE_MESSAGE);
    this.name = 'InvalidVideoUploadStateError';
  }
}

export class VideoUploadSizeExceededError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_SIZE_EXCEEDED_MESSAGE);
    this.name = 'VideoUploadSizeExceededError';
  }
}

export class VideoStorageQuotaExceededError extends Error {
  constructor() {
    super(VIDEO_STORAGE_QUOTA_EXCEEDED_MESSAGE);
    this.name = 'VideoStorageQuotaExceededError';
  }
}

export class VideoUploadSizeMismatchError extends Error {
  constructor() {
    super(VIDEO_UPLOAD_SIZE_MISMATCH_MESSAGE);
    this.name = 'VideoUploadSizeMismatchError';
  }
}
