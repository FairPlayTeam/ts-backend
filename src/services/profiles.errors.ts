export const PUBLIC_PROFILE_NOT_FOUND_MESSAGE = 'Public profile not found';
export const PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE = 'Profile media not found';
export const SELF_FOLLOW_MESSAGE = 'Profiles cannot follow themselves';

export class PublicProfileNotFoundError extends Error {
  constructor() {
    super(PUBLIC_PROFILE_NOT_FOUND_MESSAGE);
    this.name = 'PublicProfileNotFoundError';
  }
}

export class PublicProfileMediaNotFoundError extends Error {
  constructor() {
    super(PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE);
    this.name = 'PublicProfileMediaNotFoundError';
  }
}

export class SelfFollowError extends Error {
  constructor() {
    super(SELF_FOLLOW_MESSAGE);
    this.name = 'SelfFollowError';
  }
}
