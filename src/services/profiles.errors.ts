export const PUBLIC_PROFILE_NOT_FOUND_MESSAGE = 'Public profile not found';
export const SELF_FOLLOW_MESSAGE = 'Profiles cannot follow themselves';

export class PublicProfileNotFoundError extends Error {
  constructor() {
    super(PUBLIC_PROFILE_NOT_FOUND_MESSAGE);
    this.name = 'PublicProfileNotFoundError';
  }
}

export class SelfFollowError extends Error {
  constructor() {
    super(SELF_FOLLOW_MESSAGE);
    this.name = 'SelfFollowError';
  }
}
