import { describe, expect, test } from 'bun:test';
import {
  deleteAccountResponseSchema,
  loginSchema,
  logoutSessionSchema,
  registerSchema,
  requestPasswordResetSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  sensitiveActionReauthenticationSchema,
  updateProfileSchema,
  userSessionsSchema,
  userSessionsResponseSchema,
  verifyEmailSchema,
} from '../src/controllers/auth.schemas.js';
import {
  SESSION_DEVICE_INFO_MAX_LENGTH,
  SESSION_IP_ADDRESS_MAX_LENGTH,
  SESSION_USER_AGENT_MAX_LENGTH,
} from '../src/config/constants.js';
import {
  DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
  DELETE_ACCOUNT_SUCCESS_MESSAGE,
} from '../src/services/auth/auth.messages.js';

const validRegisterBody = {
  email: 'user@example.com',
  username: 'fairplay_user',
  password: 'Password1!',
};

const sensitiveActionBody = {
  currentPassword: 'Password1!',
};

describe('registerSchema', () => {
  test('accepts a valid register payload', () => {
    const result = registerSchema.safeParse({ body: validRegisterBody });

    expect(result.success).toBe(true);
  });

  test('normalizes register email and username casing', () => {
    const result = registerSchema.safeParse({
      body: {
        email: ' USER@Example.COM ',
        username: ' FairPlay_User ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toEqual({
        email: 'user@example.com',
        username: 'fairplay_user',
        password: 'Password1!',
      });
    }
  });

  test('rejects unexpected body properties', () => {
    const result = registerSchema.safeParse({
      body: {
        ...validRegisterBody,
        role: 'admin',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects weak passwords', () => {
    const result = registerSchema.safeParse({
      body: {
        ...validRegisterBody,
        password: 'password',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('resendVerificationSchema', () => {
  test('accepts a valid resend verification payload', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'user@example.com',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects invalid resend verification emails', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'not-an-email',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected resend verification properties', () => {
    const result = resendVerificationSchema.safeParse({
      body: {
        email: 'user@example.com',
        token: 'unexpected',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('requestPasswordResetSchema', () => {
  test('accepts a valid password reset request payload and normalizes email', () => {
    const result = requestPasswordResetSchema.safeParse({
      body: {
        email: ' USER@Example.COM ',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.email).toBe('user@example.com');
    }
  });

  test('rejects unexpected password reset request properties', () => {
    const result = requestPasswordResetSchema.safeParse({
      body: {
        email: 'user@example.com',
        token: 'unexpected',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  test('accepts a valid password reset code payload and normalizes email', () => {
    const result = resetPasswordSchema.safeParse({
      body: {
        email: ' USER@Example.COM ',
        code: '012345',
        password: 'NewPassword1!',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.email).toBe('user@example.com');
      expect(result.data.body.code).toBe('012345');
      expect(result.data.body.password).toBe('NewPassword1!');
    }
  });

  test('rejects malformed password reset codes', () => {
    const result = resetPasswordSchema.safeParse({
      body: {
        email: 'user@example.com',
        code: 'not-a-code',
        password: 'NewPassword1!',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected password reset properties', () => {
    const result = resetPasswordSchema.safeParse({
      body: {
        email: 'user@example.com',
        code: '123456',
        password: 'NewPassword1!',
        token: 'a'.repeat(64),
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  test('accepts a valid login payload and normalizes the identifier', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: ' USER@Example.COM ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.emailOrUsername).toBe('user@example.com');
    }
  });

  test('rejects empty login identifiers', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: ' ',
        password: 'Password1!',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected login properties', () => {
    const result = loginSchema.safeParse({
      body: {
        emailOrUsername: 'user@example.com',
        password: 'Password1!',
        rememberMe: true,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('verifyEmailSchema', () => {
  test('accepts a valid verification code and normalizes the email', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        email: ' USER@Example.COM ',
        code: '012345',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.email).toBe('user@example.com');
      expect(result.data.body.code).toBe('012345');
    }
  });

  test('rejects malformed verification codes', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        email: 'user@example.com',
        code: 'not-a-code',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected verification properties', () => {
    const result = verifyEmailSchema.safeParse({
      body: {
        email: 'user@example.com',
        code: '123456',
        token: 'a'.repeat(64),
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('logoutSessionSchema', () => {
  test('accepts a valid session id param', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects malformed session id params', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: 'not-a-session-id',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected session params', () => {
    const result = logoutSessionSchema.safeParse({
      params: {
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        userId: '123e4567-e89b-12d3-a456-426614174001',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('userSessionsSchema', () => {
  test('accepts valid pagination query params and coerces limit', () => {
    const result = userSessionsSchema.safeParse({
      query: {
        limit: '25',
        cursorLastUsedAt: '2026-01-01T00:00:00.000Z',
        cursorId: '123e4567-e89b-12d3-a456-426614174000',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toEqual({
        limit: 25,
        cursorLastUsedAt: '2026-01-01T00:00:00.000Z',
        cursorId: '123e4567-e89b-12d3-a456-426614174000',
      });
    }
  });

  test('rejects incomplete pagination cursors', () => {
    const result = userSessionsSchema.safeParse({
      query: {
        cursorLastUsedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects limits above the maximum', () => {
    const result = userSessionsSchema.safeParse({
      query: {
        limit: '101',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('userSessionsResponseSchema', () => {
  const validSession = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    sessionKeySuffix: '9a8b7c6d',
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
    deviceInfo: 'Mozilla/5.0',
    isCurrent: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-31T00:00:00.000Z',
  };

  test('accepts bounded session metadata', () => {
    const result = userSessionsResponseSchema.safeParse({
      sessions: [validSession],
      total: 1,
      nextCursor: null,
    });

    expect(result.success).toBe(true);
  });

  test('rejects oversized session metadata', () => {
    const result = userSessionsResponseSchema.safeParse({
      sessions: [
        {
          ...validSession,
          ipAddress: '1'.repeat(SESSION_IP_ADDRESS_MAX_LENGTH + 1),
          userAgent: 'A'.repeat(SESSION_USER_AGENT_MAX_LENGTH + 1),
          deviceInfo: 'A'.repeat(SESSION_DEVICE_INFO_MAX_LENGTH + 1),
        },
      ],
      total: 1,
      nextCursor: null,
    });

    expect(result.success).toBe(false);
  });
});

describe('sensitive action reauthentication schemas', () => {
  test('accept valid current password confirmation payloads', () => {
    const result = sensitiveActionReauthenticationSchema.safeParse({ body: sensitiveActionBody });

    expect(result.success).toBe(true);
  });

  test('reject missing or unexpected reauthentication fields', () => {
    expect(sensitiveActionReauthenticationSchema.safeParse({ body: {} }).success).toBe(false);
    expect(
      sensitiveActionReauthenticationSchema.safeParse({
        body: {
          ...sensitiveActionBody,
          reason: 'cleanup',
        },
      }).success,
    ).toBe(false);
    expect(
      sensitiveActionReauthenticationSchema.safeParse({
        body: {
          currentPassword: '',
        },
      }).success,
    ).toBe(false);
  });
});

describe('updateProfileSchema', () => {
  test('accepts and normalizes a valid profile update payload', () => {
    const result = updateProfileSchema.safeParse({
      body: {
        displayName: ' Fairplay User ',
        bio: ' Definitely not an undercover Y**tube employee. ',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toEqual({
        displayName: 'Fairplay User',
        bio: 'Definitely not an undercover Y**tube employee.',
      });
    }
  });

  test('accepts null profile fields for clearing values', () => {
    const result = updateProfileSchema.safeParse({
      body: {
        displayName: null,
        bio: null,
      },
    });

    expect(result.success).toBe(true);
  });

  test('rejects empty profile update payloads', () => {
    const result = updateProfileSchema.safeParse({
      body: {},
    });

    expect(result.success).toBe(false);
  });

  test('rejects unexpected profile update properties', () => {
    const result = updateProfileSchema.safeParse({
      body: {
        displayName: 'Fairplay User',
        role: 'admin',
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('deleteAccountResponseSchema', () => {
  test('accepts account deletion responses with media cleanup counts', () => {
    expect(
      deleteAccountResponseSchema.safeParse({
        message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
        mediaCleanupQueued: 0,
      }).success,
    ).toBe(true);

    expect(
      deleteAccountResponseSchema.safeParse({
        message: DELETE_ACCOUNT_MEDIA_CLEANUP_QUEUED_MESSAGE,
        mediaCleanupQueued: 2,
      }).success,
    ).toBe(true);
  });

  test('rejects invalid account deletion response shapes', () => {
    expect(
      deleteAccountResponseSchema.safeParse({
        message: 'Account deleted',
        mediaCleanupQueued: 0,
      }).success,
    ).toBe(false);

    expect(
      deleteAccountResponseSchema.safeParse({
        message: DELETE_ACCOUNT_SUCCESS_MESSAGE,
        mediaCleanupQueued: -1,
      }).success,
    ).toBe(false);
  });
});
