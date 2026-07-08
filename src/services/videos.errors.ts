export const VIDEO_NOT_FOUND_MESSAGE = 'Video not found';
export const VIDEO_UPLOAD_SESSION_NOT_FOUND_MESSAGE = 'Video upload session not found';
export const ACTIVE_VIDEO_UPLOAD_SESSION_EXISTS_MESSAGE =
  'An active upload session already exists for this video';
export const VIDEO_UPLOAD_SESSION_EXPIRED_MESSAGE = 'Video upload session expired';
export const VIDEO_UPLOAD_SESSION_STATE_MESSAGE = 'Video upload session is not in a valid state';
export const VIDEO_UPLOAD_STATE_MESSAGE = 'Video is not in a valid upload state';

export class VideoNotFoundError extends Error {
  constructor() {
    super(VIDEO_NOT_FOUND_MESSAGE);
    this.name = 'VideoNotFoundError';
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
