import { describe, expect, it } from 'bun:test';
import { buildFollowersVisibilityWhere, buildFollowingVisibilityWhere } from '../src/controllers/followController.js';
import { createUnavailableServiceCheck } from '../src/lib/health.js';
import { getPublicErrorMessage } from '../src/middleware/errorHandler.js';

describe('getPublicErrorMessage', () => {
  it('keeps explicit client-facing 4xx messages', () => {
    expect(
      getPublicErrorMessage(
        { name: 'BadRequestError', message: 'Invalid payload' },
        400,
      ),
    ).toBe('Invalid payload');
  });

  it('hides internal 5xx details from clients', () => {
    expect(
      getPublicErrorMessage(
        { name: 'DatabaseError', message: 'connect ECONNREFUSED 127.0.0.1:5432' },
        500,
      ),
    ).toBe('Internal Server Error');
  });
});

describe('createUnavailableServiceCheck', () => {
  it('returns a generic public error for database failures', () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      const check = createUnavailableServiceCheck(
        'database',
        Date.now() - 25,
        new Error('password authentication failed for user postgres'),
      );

      expect(check.status).toBe('down');
      expect(check.error).toBe('Database unavailable');
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('relationship visibility helpers', () => {
  it('hides banned followers for non-staff requests', () => {
    expect(buildFollowersVisibilityWhere(false)).toEqual({
      follower: { isBanned: false },
    });
  });

  it('hides banned following users for non-staff requests', () => {
    expect(buildFollowingVisibilityWhere(false)).toEqual({
      following: { isBanned: false },
    });
  });

  it('does not add a filter for staff requests', () => {
    expect(buildFollowersVisibilityWhere(true)).toEqual({});
    expect(buildFollowingVisibilityWhere(true)).toEqual({});
  });
});
