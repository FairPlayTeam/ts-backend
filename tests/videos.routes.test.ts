import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { AUTH_SESSION_REQUIRED_MESSAGE } from '../src/middleware/auth.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';
import type {
  AbortVideoMultipartUploadInput,
  CompleteVideoMultipartUploadInput,
  CreateVideoInput,
  GetVideoMultipartUploadSessionInput,
  InitVideoMultipartUploadInput,
  ListMyVideosInput,
  SignVideoMultipartUploadPartsInput,
  VideosPorts,
} from '../src/services/videos.types.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

let server: Server;
let baseUrl: string;
let receivedInitRequest: InitVideoMultipartUploadInput | undefined;
let receivedCreateRequest: CreateVideoInput | undefined;
let receivedSignRequest: SignVideoMultipartUploadPartsInput | undefined;
let receivedCompleteRequest: CompleteVideoMultipartUploadInput | undefined;
let receivedAbortRequest: AbortVideoMultipartUploadInput | undefined;
let receivedGetRequest: GetVideoMultipartUploadSessionInput | undefined;
let receivedListRequest: ListMyVideosInput | undefined;
let receivedSessionKey: string | undefined;

const videoId = '0d4e55cb-c278-4d74-a192-bf7c10888c7a';
const uploadSessionId = '22222222-2222-4222-8222-222222222222';
const authenticatedUserId = '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f';

describe('videos routes multipart uploads', () => {
  beforeAll(async () => {
    const authService = createStubAuthService();
    const videosService = createStubVideosService();
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
        adminService: createStubAdminService(),
        authService: {
          ...authService,
          validateSession: async (sessionKey) => {
            receivedSessionKey = sessionKey;

            return authService.validateSession(sessionKey);
          },
        },
        profilesService: createStubProfilesService(),
        videosService: {
          ...videosService,
          createVideo: async (input) => {
            receivedCreateRequest = input;

            return videosService.createVideo(input);
          },
          listMyVideos: async (input) => {
            receivedListRequest = input;

            return videosService.listMyVideos(input);
          },
          initMultipartUpload: async (input) => {
            receivedInitRequest = input;

            if (input.videoId === '11111111-1111-4111-8111-111111111111') {
              throw new VideoNotFoundError();
            }

            return videosService.initMultipartUpload(input);
          },
          signMultipartUploadParts: async (input) => {
            receivedSignRequest = input;

            return videosService.signMultipartUploadParts(input);
          },
          completeMultipartUpload: async (input) => {
            receivedCompleteRequest = input;

            return videosService.completeMultipartUpload(input);
          },
          abortMultipartUpload: async (input) => {
            receivedAbortRequest = input;

            return videosService.abortMultipartUpload(input);
          },
          getMultipartUploadSession: async (input) => {
            receivedGetRequest = input;

            return videosService.getMultipartUploadSession(input);
          },
        } satisfies VideosPorts,
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

  test('creates video metadata with an authenticated session', async () => {
    receivedCreateRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'FairPlay launch recap',
        description: 'A short behind-the-scenes video.',
        tags: ['fairplay', 'launch', 'fairplay'],
        license: 'all_rights_reserved',
        visibility: 'public',
        allowComments: false,
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedCreateRequest = receivedCreateRequest as CreateVideoInput | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedCreateRequest).toEqual({
      userId: authenticatedUserId,
      title: 'FairPlay launch recap',
      description: 'A short behind-the-scenes video.',
      tags: ['fairplay', 'launch'],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: false,
    });
    expect(await response.json()).toMatchObject({
      video: {
        ownerId: authenticatedUserId,
        title: 'FairPlay launch recap',
        description: 'A short behind-the-scenes video.',
        tags: ['fairplay', 'launch'],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: false,
        processingStatus: 'draft',
        moderationStatus: 'pending',
      },
    });
  });

  test('requires authentication before creating video metadata', async () => {
    receivedCreateRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'FairPlay launch recap',
      }),
    });

    expect(response.status).toBe(401);
    expect(receivedSessionKey).toBeUndefined();
    expect(receivedCreateRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('lists current user videos with stable pagination input', async () => {
    receivedListRequest = undefined;
    receivedSessionKey = undefined;
    const query = new URLSearchParams({
      limit: '10',
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
      cursorId: videoId,
    });

    const response = await fetch(`${baseUrl}/videos/me?${query.toString()}`, {
      headers: {
        Authorization: 'Bearer route-session-key',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedListRequest = receivedListRequest as ListMyVideosInput | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedListRequest).toEqual({
      userId: authenticatedUserId,
      limit: 10,
      cursor: {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        id: videoId,
      },
    });
    expect(await response.json()).toMatchObject({
      videos: [
        {
          ownerId: authenticatedUserId,
          visibility: 'unlisted',
          processingStatus: 'uploading',
          moderationStatus: 'pending',
        },
      ],
      total: 1,
      nextCursor: null,
    });
  });

  test('rejects malformed current user video pagination cursors', async () => {
    receivedListRequest = undefined;

    const response = await fetch(
      `${baseUrl}/videos/me?cursorCreatedAt=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`,
      {
        headers: {
          Authorization: 'Bearer route-session-key',
        },
      },
    );

    expect(response.status).toBe(400);
    expect(receivedListRequest).toBeUndefined();
    expect(await response.json()).toMatchObject({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
    });
  });

  test('rejects private video visibility before calling the service', async () => {
    receivedCreateRequest = undefined;

    const response = await fetch(`${baseUrl}/videos`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'FairPlay launch recap',
        visibility: 'private',
      }),
    });

    expect(response.status).toBe(400);
    expect(receivedCreateRequest).toBeUndefined();
    expect(await response.json()).toMatchObject({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
    });
  });

  test('initializes a multipart upload with an authenticated session', async () => {
    receivedInitRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/${videoId}/upload/multipart/init`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedInitRequest = receivedInitRequest as InitVideoMultipartUploadInput | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedInitRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
    });
    expect(await response.json()).toMatchObject({
      uploadSession: {
        status: 'initiated',
        bucket: 'videos',
        uploadId: 'test-upload-id',
        partSizeBytes: 67_108_864,
      },
    });
  });

  test('requires authentication before initializing an upload', async () => {
    receivedInitRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/${videoId}/upload/multipart/init`, {
      method: 'POST',
    });

    expect(response.status).toBe(401);
    expect(receivedSessionKey).toBeUndefined();
    expect(receivedInitRequest).toBeUndefined();
    expect(await response.json()).toEqual({
      error: 'Unauthorized',
      message: AUTH_SESSION_REQUIRED_MESSAGE,
    });
  });

  test('signs multipart upload parts with JSON body only', async () => {
    receivedSignRequest = undefined;

    const response = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1],
        }),
      },
    );

    expect(response.status).toBe(200);
    const observedSignRequest = receivedSignRequest as
      | SignVideoMultipartUploadPartsInput
      | undefined;
    expect(observedSignRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
      uploadSessionId,
      partNumbers: [1],
    });
    expect(await response.json()).toEqual({
      uploadSessionId,
      parts: [
        {
          partNumber: 1,
          url: 'http://localhost:9000/videos/user-id/video-id/original.mp4?partNumber=1&uploadId=test-upload-id',
        },
      ],
    });
  });

  test('rejects duplicate part numbers before calling the service', async () => {
    receivedSignRequest = undefined;

    const response = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}/parts/sign`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          partNumbers: [1, 1],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(receivedSignRequest).toBeUndefined();
    expect(await response.json()).toMatchObject({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
    });
  });

  test('completes a multipart upload', async () => {
    receivedCompleteRequest = undefined;

    const response = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parts: [{ partNumber: 1, etag: '"etag-1"' }],
        }),
      },
    );

    expect(response.status).toBe(200);
    const observedCompleteRequest = receivedCompleteRequest as
      | CompleteVideoMultipartUploadInput
      | undefined;
    expect(observedCompleteRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
      uploadSessionId,
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    });
    expect(await response.json()).toMatchObject({
      uploadSession: {
        status: 'completed',
        partCount: 1,
      },
    });
  });

  test('aborts a multipart upload and reads its session', async () => {
    receivedAbortRequest = undefined;
    receivedGetRequest = undefined;

    const abortResponse = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}/abort`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
        },
      },
    );
    const getResponse = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}`,
      {
        headers: {
          Authorization: 'Bearer route-session-key',
        },
      },
    );

    expect(abortResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    const observedAbortRequest = receivedAbortRequest as AbortVideoMultipartUploadInput | undefined;
    const observedGetRequest = receivedGetRequest as
      | GetVideoMultipartUploadSessionInput
      | undefined;
    expect(observedAbortRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
      uploadSessionId,
    });
    expect(observedGetRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
      uploadSessionId,
    });
  });

  test('maps missing videos to not found', async () => {
    const response = await fetch(
      `${baseUrl}/videos/11111111-1111-4111-8111-111111111111/upload/multipart/init`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'NotFound',
      message: 'Video not found',
    });
  });
});
