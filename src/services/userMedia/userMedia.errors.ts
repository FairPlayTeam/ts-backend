export const USER_MEDIA_FILE_REQUIRED_MESSAGE = 'A media file is required';
export const USER_MEDIA_FILE_TOO_LARGE_MESSAGE = 'Media file is too large';
export const USER_MEDIA_UNSUPPORTED_TYPE_MESSAGE = 'Media file must be a JPEG, PNG, or WebP image';
export const USER_MEDIA_INVALID_IMAGE_MESSAGE = 'Media file could not be processed as an image';

export class UserMediaFileRequiredError extends Error {
  constructor(message = USER_MEDIA_FILE_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'UserMediaFileRequiredError';
  }
}

export class UserMediaFileTooLargeError extends Error {
  constructor(message = USER_MEDIA_FILE_TOO_LARGE_MESSAGE) {
    super(message);
    this.name = 'UserMediaFileTooLargeError';
  }
}

export class UserMediaUnsupportedTypeError extends Error {
  constructor(message = USER_MEDIA_UNSUPPORTED_TYPE_MESSAGE) {
    super(message);
    this.name = 'UserMediaUnsupportedTypeError';
  }
}

export class UserMediaInvalidImageError extends Error {
  constructor(message = USER_MEDIA_INVALID_IMAGE_MESSAGE, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'UserMediaInvalidImageError';
  }
}
