import { describe, expect, it } from 'bun:test';
import {
  canAccessVideo,
  canBuildPlaybackUrls,
} from '../src/lib/videoAccess.js';

const baseVideo = {
  userId: 'owner-id',
  visibility: 'public' as const,
  processingStatus: 'done' as const,
  moderationStatus: 'approved' as const,
  user: {
    isBanned: false,
  },
};

describe('canAccessVideo', () => {
  it('allows anonymous access to approved public videos', () => {
    expect(canAccessVideo(baseVideo, null)).toBe(true);
  });

  it('blocks anonymous access to private videos', () => {
    expect(
      canAccessVideo({ ...baseVideo, visibility: 'private' }, null),
    ).toBe(false);
  });

  it('allows owners and staff to access restricted videos', () => {
    const privateVideo = { ...baseVideo, visibility: 'private' as const };

    expect(canAccessVideo(privateVideo, { id: 'owner-id', role: 'user' })).toBe(
      true,
    );
    expect(canAccessVideo(privateVideo, { id: 'staff-id', role: 'moderator' })).toBe(
      true,
    );
  });

  it('blocks public access when the owner is banned', () => {
    expect(
      canAccessVideo({ ...baseVideo, user: { isBanned: true } }, null),
    ).toBe(false);
  });
});

describe('canBuildPlaybackUrls', () => {
  it('requires the processed video to be done', () => {
    expect(
      canBuildPlaybackUrls(
        { ...baseVideo, processingStatus: 'processing' },
        { id: 'owner-id', role: 'user' },
      ),
    ).toBe(false);
  });
});
