export const PUBLIC_PROFILE_NOT_FOUND_MESSAGE = 'Public profile not found';

export class PublicProfileNotFoundError extends Error {
  constructor() {
    super(PUBLIC_PROFILE_NOT_FOUND_MESSAGE);
    this.name = 'PublicProfileNotFoundError';
  }
}
