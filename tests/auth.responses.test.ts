import { describe, expect, test } from 'bun:test';
import {
  toAuthSessionResponse,
  toAuthUserProfileResponse,
  toUserMediaAssetResponse,
  toUserSessionsResponse,
} from '../src/modules/auth/http/responses.js';
import { LOGIN_SUCCESS_MESSAGE } from '../src/modules/auth/messages.js';

const hostileFields = {
  passwordHash: 'hostile-password-hash',
  sessionKeyHash: 'hostile-session-key-hash',
  objectKey: 'hostile-storage-object-key',
  externalResourceTargetId: 'hostile-reconciliation-target-id',
  internalMarker: 'hostile-internal-marker',
};

const addHostileFields = <T extends object>(value: T) => ({
  ...value,
  ...hostileFields,
});

describe('auth HTTP response serializers', () => {
  test('serializes a login response through its public field whitelist', () => {
    const expiresAt = new Date('2026-01-31T00:00:00.000Z');
    const session = addHostileFields({
      id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      expiresAt,
    });
    const user = addHostileFields({
      id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      email: 'user@example.com',
      username: 'fairplay_user',
      displayName: 'Fairplay User',
      bio: null,
      role: 'user' as const,
    });
    const result = addHostileFields({
      message: LOGIN_SUCCESS_MESSAGE,
      user,
      sessionKey: 'test-session-key',
      session,
    });

    const serialized = JSON.stringify(toAuthSessionResponse(result));

    expect(serialized).toBe(
      JSON.stringify({
        message: LOGIN_SUCCESS_MESSAGE,
        user: {
          id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
          email: 'user@example.com',
          username: 'fairplay_user',
          displayName: 'Fairplay User',
          bio: null,
          role: 'user',
        },
        sessionKey: 'test-session-key',
        session: {
          id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
          expiresAt: '2026-01-31T00:00:00.000Z',
        },
      }),
    );
    expect(serialized).not.toContain('hostile-');
  });

  test('serializes a profile and media asset through explicit public fields', () => {
    const updatedAt = new Date('2026-01-01T00:00:00.000Z');
    const profile = addHostileFields({
      id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      email: 'user@example.com',
      username: 'fairplay_user',
      displayName: 'Fairplay User',
      bio: null,
      role: 'user' as const,
      avatarUrl: '/profiles/fairplay_user/avatar',
      bannerUrl: '/profiles/fairplay_user/banner',
    });
    const asset = addHostileFields({
      url: '/profiles/fairplay_user/avatar',
      mimeType: 'image/webp',
      sizeBytes: 1234,
      width: 512,
      height: 512,
      updatedAt,
    });
    const profileJson = JSON.stringify(toAuthUserProfileResponse(profile));
    const mediaJson = JSON.stringify(toUserMediaAssetResponse(asset));

    expect(profileJson).toBe(
      JSON.stringify({
        id: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
        email: 'user@example.com',
        username: 'fairplay_user',
        displayName: 'Fairplay User',
        bio: null,
        role: 'user',
        avatarUrl: '/profiles/fairplay_user/avatar',
        bannerUrl: '/profiles/fairplay_user/banner',
      }),
    );
    expect(mediaJson).toBe(
      JSON.stringify({
        url: '/profiles/fairplay_user/avatar',
        mimeType: 'image/webp',
        sizeBytes: 1234,
        width: 512,
        height: 512,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(profileJson).not.toContain('hostile-');
    expect(mediaJson).not.toContain('hostile-');
  });

  test('serializes session summaries through their public field whitelist', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const session = addHostileFields({
      id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
      sessionKeySuffix: 'sion-key',
      ipAddress: '127.0.0.1',
      userAgent: 'bun-test',
      deviceInfo: 'bun-test',
      isCurrent: true,
      createdAt,
      lastUsedAt: createdAt,
      expiresAt: new Date('2026-01-31T00:00:00.000Z'),
    });
    const result = addHostileFields({
      sessions: [session],
      total: 1,
      nextCursor: { lastUsedAt: createdAt, id: session.id },
    });
    const serialized = JSON.stringify(toUserSessionsResponse(result));

    expect(serialized).toBe(
      JSON.stringify({
        sessions: [
          {
            id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
            sessionKeySuffix: 'sion-key',
            ipAddress: '127.0.0.1',
            userAgent: 'bun-test',
            deviceInfo: 'bun-test',
            isCurrent: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-31T00:00:00.000Z',
          },
        ],
        total: 1,
        nextCursor: {
          lastUsedAt: '2026-01-01T00:00:00.000Z',
          id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
        },
      }),
    );
    expect(serialized).not.toContain('hostile-');
  });
});
