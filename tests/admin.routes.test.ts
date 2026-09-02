import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import {
  ADMIN_ACCOUNTS_CURSOR_PAIR_MESSAGE,
  type AdminAccountsQuery,
  type BanAdminAccountBody,
  type UpdateAdminAccountRoleBody,
} from '../src/controllers/admin.schemas.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { AUTH_SESSION_REQUIRED_MESSAGE } from '../src/middleware/auth.js';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../src/middleware/routeProtection.js';
import type {
  AdminPorts,
  BanAdminAccountInput,
  ListAdminAccountsInput,
  ListAdminVideosInput,
  ModerateAdminVideoInput,
  RequestAdminVideoDeletionInput,
  UnbanAdminAccountInput,
  UpdateAdminAccountRoleInput,
} from '../src/services/admin.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

let server: Server;
let baseUrl: string;
let receivedBanAccountRequest: BanAdminAccountInput | undefined;
let receivedListAccountsRequest: ListAdminAccountsInput | undefined;
let receivedListVideosRequest: ListAdminVideosInput | undefined;
let receivedModerateVideoRequest: ModerateAdminVideoInput | undefined;
let receivedVideoDeletionRequest: RequestAdminVideoDeletionInput | undefined;
let receivedUnbanAccountRequest: UnbanAdminAccountInput | undefined;
let receivedUpdateAccountRoleRequest: UpdateAdminAccountRoleInput | undefined;
let receivedSessionKey: string | undefined;

const adminSessionKey = 'admin-session-key';
const moderatorSessionKey = 'moderator-session-key';
const userSessionKey = 'user-session-key';
const cursorCreatedAt = '2026-01-01T00:00:00.000Z';
const cursorId = '11111111-1111-4111-8111-111111111111';

describe('admin routes', () => {
  beforeAll(async () => {
    const authService = createStubAuthService();
    const adminService = createStubAdminService();
    const app = await createApp(
      {
        allowedOrigins: [],
        profileMediaMaxUploadBytes: 3 * 1024 * 1024,
        baseUrl: 'http://localhost:3000/',
        isProduction: false,
        jsonBodyLimitBytes: 1024 * 1024,
        rateLimitKeySecret: 'test-rate-limit-key-secret-123456',
        trustProxy: false,
      },
      {
        adminService: {
          ...adminService,
          banAccount: async (input) => {
            receivedBanAccountRequest = input;

            return adminService.banAccount(input);
          },
          listAccounts: async (input) => {
            receivedListAccountsRequest = input;

            return adminService.listAccounts(input);
          },
          listVideos: async (input) => {
            receivedListVideosRequest = input;

            return adminService.listVideos(input);
          },
          moderateVideo: async (input) => {
            receivedModerateVideoRequest = input;

            return adminService.moderateVideo(input);
          },
          requestVideoDeletion: async (input) => {
            receivedVideoDeletionRequest = input;

            return adminService.requestVideoDeletion(input);
          },
          unbanAccount: async (input) => {
            receivedUnbanAccountRequest = input;

            return adminService.unbanAccount(input);
          },
          updateAccountRole: async (input) => {
            receivedUpdateAccountRoleRequest = input;

            return adminService.updateAccountRole(input);
          },
        } satisfies AdminPorts,
        authService: {
          ...authService,
          validateSession: async (sessionKey) => {
            receivedSessionKey = sessionKey;
            const result = await authService.validateSession(sessionKey);

            if (!result) {
              return result;
            }

            return {
              ...result,
              user: {
                ...result.user,
                role:
                  sessionKey === adminSessionKey
                    ? 'admin'
                    : sessionKey === moderatorSessionKey
                      ? 'moderator'
                      : 'user',
              },
            };
          },
        },
        profilesService: createStubProfilesService(),
        videosService: createStubVideosService(),
      },
    );

    server = app.listen(0);
    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }

    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  });

  test('lists accounts for an administrator session', async () => {
    receivedListAccountsRequest = undefined;
    receivedSessionKey = undefined;
    const query = new URLSearchParams({
      banStatus: 'notbanned',
      cursorCreatedAt,
      cursorId,
      limit: '10',
      search: '  Admin Listed  ',
    });

    const response = await fetch(`${baseUrl}/admin/users?${query.toString()}`, {
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
      },
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedListAccountsRequest = receivedListAccountsRequest as
      ListAdminAccountsInput | undefined;
    expect(observedSessionKey).toBe(adminSessionKey);
    expect(observedListAccountsRequest).toEqual({
      banStatus: 'notbanned',
      limit: 10,
      search: 'Admin Listed',
      cursor: {
        createdAt: new Date(cursorCreatedAt),
        id: cursorId,
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      accounts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'admin-listed@example.com',
          username: 'admin_listed',
          displayName: 'Admin Listed',
          avatarUrl: '/profiles/fairplay_user/avatar',
          createdAt: '2026-01-01T00:00:00.000Z',
          isVerified: true,
          isBanned: false,
          bannedAt: null,
          lastLogin: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          role: 'user',
        },
      ],
      total: 1,
      nextCursor: null,
    });
  });

  test('lists moderation videos for a moderator with filters, sorting, and text search', async () => {
    receivedListVideosRequest = undefined;
    const query = new URLSearchParams({
      moderationStatus: 'pending',
      processingStatus: 'ready',
      sort: 'oldest',
      search: '  awaiting moderation  ',
      cursorCreatedAt,
      cursorId,
      limit: '10',
    });
    const response = await fetch(`${baseUrl}/moderation/videos?${query.toString()}`, {
      headers: {
        authorization: `Bearer ${moderatorSessionKey}`,
      },
    });

    expect(response.status).toBe(200);
    const observedListVideosRequest = receivedListVideosRequest as ListAdminVideosInput | undefined;
    expect(observedListVideosRequest).toEqual({
      moderationStatus: 'pending',
      processingStatus: 'ready',
      sort: 'oldest',
      search: 'awaiting moderation',
      limit: 10,
      cursor: {
        createdAt: new Date(cursorCreatedAt),
        id: cursorId,
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      videos: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          publicId: 'AdminVid01_',
          ownerId: '11111111-1111-4111-8111-111111111111',
          username: 'admin_listed',
          title: 'Video awaiting moderation',
          moderationStatus: 'pending',
          processingStatus: 'ready',
          visibility: 'unlisted',
          createdAt: '2026-01-01T00:00:00.000Z',
          thumbnailPath: '/videos/AbCdEf123_/thumbnail',
          publishedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          deletionRequestedAt: null,
          deletionReason: null,
          deletionOrigin: null,
        },
      ],
      total: 1,
      nextCursor: null,
    });
  });

  test('applies a moderation decision for a moderator', async () => {
    receivedModerateVideoRequest = undefined;
    const response = await fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${moderatorSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved' }),
    });

    expect(response.status).toBe(200);
    const observedModerateVideoRequest = receivedModerateVideoRequest as
      ModerateAdminVideoInput | undefined;
    expect(observedModerateVideoRequest).toEqual({
      videoId: cursorId,
      decision: 'approved',
    });
    expect(await response.json()).toEqual({
      video: {
        id: '33333333-3333-4333-8333-333333333333',
        publicId: 'AdminVid01_',
        ownerId: '11111111-1111-4111-8111-111111111111',
        username: 'admin_listed',
        title: 'Moderated video',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        visibility: 'public',
        createdAt: '2026-01-01T00:00:00.000Z',
        thumbnailPath: '/videos/AbCdEf123_/thumbnail',
        publishedAt: '2026-01-05T00:00:00.000Z',
        rejectedAt: null,
        rejectionReason: null,
        deletionRequestedAt: null,
        deletionReason: null,
        deletionOrigin: null,
      },
    });
  });

  test('schedules administrative deletion with the validated session role and a whitelisted response', async () => {
    receivedVideoDeletionRequest = undefined;
    const response = await fetch(`${baseUrl}/moderation/videos/${cursorId}/deletion`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: '  Published safety violation.  ' }),
    });

    expect(response.status).toBe(200);
    const observedVideoDeletionRequest = receivedVideoDeletionRequest as
      RequestAdminVideoDeletionInput | undefined;
    expect(observedVideoDeletionRequest).toEqual({
      actorRole: 'admin',
      reason: 'Published safety violation.',
      videoId: cursorId,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      video: {
        id: '33333333-3333-4333-8333-333333333333',
        publicId: 'AdminVid01_',
        ownerId: '11111111-1111-4111-8111-111111111111',
        username: 'admin_listed',
        title: 'Video scheduled for deletion',
        moderationStatus: 'approved',
        processingStatus: 'ready',
        visibility: 'unlisted',
        createdAt: '2026-01-01T00:00:00.000Z',
        thumbnailPath: '/videos/AbCdEf123_/thumbnail',
        publishedAt: '2026-01-05T00:00:00.000Z',
        rejectedAt: null,
        rejectionReason: null,
        deletionRequestedAt: '2026-01-06T00:00:00.000Z',
        deletionReason: 'Published safety violation.',
        deletionOrigin: 'admin',
      },
    });
  });

  test('rejects invalid administrative deletion reasons before calling the service', async () => {
    receivedVideoDeletionRequest = undefined;
    const response = await fetch(`${baseUrl}/moderation/videos/${cursorId}/deletion`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${moderatorSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'reason\u0000tail' }),
    });

    expect(response.status).toBe(400);
    expect(receivedVideoDeletionRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'body.reason',
          message: 'Video deletion reason must not contain NUL characters',
        },
      ],
    });
  });

  test('rejects moderation bodies that do not match the strict decision branch', async () => {
    receivedModerateVideoRequest = undefined;

    const [missingReasonResponse, superfluousReasonResponse] = await Promise.all([
      fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${moderatorSessionKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'rejected' }),
      }),
      fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${moderatorSessionKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved', reason: 'Not accepted on approval.' }),
      }),
    ]);

    expect(missingReasonResponse.status).toBe(400);
    expect(superfluousReasonResponse.status).toBe(400);
    expect(receivedModerateVideoRequest).toBeUndefined();
  });

  test('rejects a NUL character in the video rejection reason before calling the service', async () => {
    receivedModerateVideoRequest = undefined;

    const response = await fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${moderatorSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'rejected', reason: 'raison\u0000suite' }),
    });

    expect(response.status).toBe(400);
    expect(receivedModerateVideoRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'body.reason',
          message: 'Video rejection reason must not contain NUL characters',
        },
      ],
    });
  });

  test('bans an account for an administrator session', async () => {
    receivedBanAccountRequest = undefined;
    receivedSessionKey = undefined;

    const body: BanAdminAccountBody = {
      reason: '  Repeated abusive behavior.  ',
    };
    const response = await fetch(`${baseUrl}/admin/users/${cursorId}/ban`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedBanAccountRequest = receivedBanAccountRequest as BanAdminAccountInput | undefined;
    expect(observedSessionKey).toBe(adminSessionKey);
    expect(observedBanAccountRequest).toEqual({
      actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      actorRole: 'admin',
      targetUserId: cursorId,
      reason: 'Repeated abusive behavior.',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      message: 'Account banned successfully',
      account: {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'banned@example.com',
        username: 'banned_user',
        displayName: 'Banned User',
        role: 'user',
        isBanned: true,
        bannedAt: '2026-01-04T00:00:00.000Z',
        banReason: 'Repeated abusive behavior.',
      },
      sessionsRevoked: 2,
      notificationEmailSent: true,
    });
  });

  test('unbans an account for an administrator session', async () => {
    receivedSessionKey = undefined;
    receivedUnbanAccountRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users/${cursorId}/unban`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
      },
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedUnbanAccountRequest = receivedUnbanAccountRequest as
      UnbanAdminAccountInput | undefined;
    expect(observedSessionKey).toBe(adminSessionKey);
    expect(observedUnbanAccountRequest).toEqual({
      actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      actorRole: 'admin',
      targetUserId: cursorId,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      message: 'Account unbanned successfully',
      account: {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'unbanned@example.com',
        username: 'unbanned_user',
        displayName: 'Unbanned User',
        role: 'user',
        isBanned: false,
        bannedAt: null,
        banReason: null,
      },
    });
  });

  test('updates an account role for an administrator session', async () => {
    receivedSessionKey = undefined;
    receivedUpdateAccountRoleRequest = undefined;

    const body: UpdateAdminAccountRoleBody = {
      role: 'moderator',
    };
    const response = await fetch(`${baseUrl}/admin/users/${cursorId}/role`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedUpdateAccountRoleRequest = receivedUpdateAccountRoleRequest as
      UpdateAdminAccountRoleInput | undefined;
    expect(observedSessionKey).toBe(adminSessionKey);
    expect(observedUpdateAccountRoleRequest).toEqual({
      actorUserId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
      actorRole: 'admin',
      targetUserId: cursorId,
      role: 'moderator',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      message: 'Account role updated successfully',
      account: {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'role-updated@example.com',
        username: 'role_updated',
        displayName: 'Role Updated',
        role: 'moderator',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
    });
  });

  test('rejects non-admin sessions before calling the admin service', async () => {
    receivedListAccountsRequest = undefined;
    receivedBanAccountRequest = undefined;
    receivedUnbanAccountRequest = undefined;
    receivedUpdateAccountRoleRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users`, {
      headers: {
        authorization: `Bearer ${userSessionKey}`,
      },
    });

    expect(response.status).toBe(403);
    expect(receivedListAccountsRequest).toBeUndefined();
    expect(receivedBanAccountRequest).toBeUndefined();
    expect(receivedUnbanAccountRequest).toBeUndefined();
    expect(receivedUpdateAccountRoleRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'Forbidden',
      message: INSUFFICIENT_PERMISSIONS_MESSAGE,
    });
  });

  test('rejects ordinary users on every moderation route before calling the admin service', async () => {
    receivedListVideosRequest = undefined;
    receivedModerateVideoRequest = undefined;
    receivedVideoDeletionRequest = undefined;

    const [listResponse, decisionResponse, deletionResponse] = await Promise.all([
      fetch(`${baseUrl}/moderation/videos`, {
        headers: {
          authorization: `Bearer ${userSessionKey}`,
        },
      }),
      fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userSessionKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'rejected', reason: 'Video policy violation.' }),
      }),
      fetch(`${baseUrl}/moderation/videos/${cursorId}/deletion`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${userSessionKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Administrative reason.' }),
      }),
    ]);

    expect(listResponse.status).toBe(403);
    expect(decisionResponse.status).toBe(403);
    expect(deletionResponse.status).toBe(403);
    expect(receivedListVideosRequest).toBeUndefined();
    expect(receivedModerateVideoRequest).toBeUndefined();
    expect(receivedVideoDeletionRequest).toBeUndefined();
    expect(await listResponse.json()).toEqual({
      error: 'Forbidden',
      message: INSUFFICIENT_PERMISSIONS_MESSAGE,
    });
    expect(await decisionResponse.json()).toEqual({
      error: 'Forbidden',
      message: INSUFFICIENT_PERMISSIONS_MESSAGE,
    });
    expect(await deletionResponse.json()).toEqual({
      error: 'Forbidden',
      message: INSUFFICIENT_PERMISSIONS_MESSAGE,
    });
  });

  test('requires a bearer session on every moderation route', async () => {
    const [listResponse, decisionResponse, deletionResponse] = await Promise.all([
      fetch(`${baseUrl}/moderation/videos`),
      fetch(`${baseUrl}/moderation/videos/${cursorId}/moderation`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ decision: 'approved' }),
      }),
      fetch(`${baseUrl}/moderation/videos/${cursorId}/deletion`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Administrative reason.' }),
      }),
    ]);

    expect(listResponse.status).toBe(401);
    expect(decisionResponse.status).toBe(401);
    expect(deletionResponse.status).toBe(401);
    expect(await listResponse.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
    expect(await decisionResponse.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
    expect(await deletionResponse.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('requires a bearer session before listing accounts', async () => {
    receivedListAccountsRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users`);

    expect(response.status).toBe(401);
    expect(receivedListAccountsRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('rejects invalid ban requests before calling the admin service', async () => {
    receivedBanAccountRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users/not-a-user-id/ban`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: '   ' }),
    });

    expect(response.status).toBe(400);
    expect(receivedBanAccountRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'params.userId',
          message: 'User id must be a valid UUID',
        },
        {
          field: 'body.reason',
          message: 'Ban reason is required',
        },
      ],
    });
  });

  test('rejects invalid unban requests before calling the admin service', async () => {
    receivedUnbanAccountRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users/not-a-user-id/unban`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
      },
    });

    expect(response.status).toBe(400);
    expect(receivedUnbanAccountRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'params.userId',
          message: 'User id must be a valid UUID',
        },
      ],
    });
  });

  test('rejects invalid role update requests before calling the admin service', async () => {
    receivedUpdateAccountRoleRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users/not-a-user-id/role`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'owner' }),
    });

    expect(response.status).toBe(400);
    expect(receivedUpdateAccountRoleRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'params.userId',
          message: 'User id must be a valid UUID',
        },
        {
          field: 'body.role',
          message: 'Invalid option: expected one of "user"|"moderator"|"admin"',
        },
      ],
    });
  });

  test('rejects malformed account pagination cursors', async () => {
    receivedListAccountsRequest = undefined;

    const query: Partial<AdminAccountsQuery> = {
      cursorCreatedAt,
    };
    const response = await fetch(
      `${baseUrl}/admin/users?cursorCreatedAt=${encodeURIComponent(query.cursorCreatedAt ?? '')}`,
      {
        headers: {
          authorization: `Bearer ${adminSessionKey}`,
        },
      },
    );

    expect(response.status).toBe(400);
    expect(receivedListAccountsRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'query',
          message: ADMIN_ACCOUNTS_CURSOR_PAIR_MESSAGE,
        },
      ],
    });
  });

  test('rejects invalid account ban status filters before calling the admin service', async () => {
    receivedListAccountsRequest = undefined;

    const response = await fetch(`${baseUrl}/admin/users?banStatus=archived`, {
      headers: {
        authorization: `Bearer ${adminSessionKey}`,
      },
    });

    expect(response.status).toBe(400);
    expect(receivedListAccountsRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
      details: [
        {
          field: 'query.banStatus',
          message: 'Invalid option: expected one of "allUsers"|"banned"|"notbanned"',
        },
      ],
    });
  });
});
