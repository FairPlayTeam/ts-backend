export const VIDEO_NOT_FOUND_MESSAGE = 'Video not found';

export class VideoNotFoundError extends Error {
  constructor() {
    super(VIDEO_NOT_FOUND_MESSAGE);
    this.name = 'VideoNotFoundError';
  }
}
