import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { REQUEST_VALIDATION_FAILED_MESSAGE } from '../src/errors/http.js';
import { AUTH_SESSION_REQUIRED_MESSAGE } from '../src/middleware/auth.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';
import { VIDEO_LICENSES } from '../src/services/videos/videoLicenses.js';
import type {
  AbortVideoMultipartUploadInput,
  CompleteVideoMultipartUploadInput,
  CreateVideoInput,
  GetMyVideoRatingInput,
  GetPublicVideoDetailInput,
  GetVideoRatingInput,
  GetVideoHlsMasterInput,
  GetVideoHlsRenditionInput,
  GetVideoHlsSegmentInput,
  GetVideoMultipartUploadSessionInput,
  GetVideoThumbnailInput,
  InitVideoMultipartUploadInput,
  ListMyVideosInput,
  RateVideoInput,
  SearchPublicVideosInput,
  SignVideoMultipartUploadPartsInput,
  UploadVideoSourceThumbnailInput,
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
let receivedThumbnailRequest: UploadVideoSourceThumbnailInput | undefined;
let receivedCompleteRequest: CompleteVideoMultipartUploadInput | undefined;
let receivedAbortRequest: AbortVideoMultipartUploadInput | undefined;
let receivedGetRequest: GetVideoMultipartUploadSessionInput | undefined;
let receivedListRequest: ListMyVideosInput | undefined;
let receivedPublicSearchRequest: SearchPublicVideosInput | undefined;
let receivedPublicVideoDetailRequest: GetPublicVideoDetailInput | undefined;
let receivedPublicRatingRequest: GetVideoRatingInput | undefined;
let receivedMyRatingRequest: GetMyVideoRatingInput | undefined;
let receivedRateVideoRequest: RateVideoInput | undefined;
let receivedHlsMasterRequest: GetVideoHlsMasterInput | undefined;
let receivedHlsRenditionRequest: GetVideoHlsRenditionInput | undefined;
let receivedHlsSegmentRequest: GetVideoHlsSegmentInput | undefined;
let receivedThumbnailReadRequest: GetVideoThumbnailInput | undefined;
let receivedSessionKey: string | undefined;

const videoId = '0d4e55cb-c278-4d74-a192-bf7c10888c7a';
const uploadSessionId = '22222222-2222-4222-8222-222222222222';
const authenticatedUserId = '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f';
const publicId = 'AbCdEf123_';
const generationId = '33333333-3333-4333-8333-333333333333';

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

            if (sessionKey === 'invalid-session-key') {
              return null;
            }

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
          searchPublicVideos: async (input) => {
            receivedPublicSearchRequest = input;

            return videosService.searchPublicVideos(input);
          },
          getPublicVideoDetail: async (input) => {
            receivedPublicVideoDetailRequest = input;
            const result = await videosService.getPublicVideoDetail(input);

            return {
              video: {
                ...result.video,
                userRating: input.userId ? 5 : null,
                id: 'internal-video-id',
                ownerId: 'internal-owner-id',
                moderationStatus: 'rejected',
                processingStatus: 'ready',
                thumbnailObjectKey: 'internal-thumbnail-key',
                hlsMasterObjectKey: 'internal-master-key',
                rejectionReason: 'internal reason',
                bucket: 'internal-bucket',
                objectKey: 'internal-object-key',
              },
            } as Awaited<ReturnType<VideosPorts['getPublicVideoDetail']>>;
          },
          getVideoRating: async (input) => {
            receivedPublicRatingRequest = input;

            return videosService.getVideoRating(input);
          },
          getMyVideoRating: async (input) => {
            receivedMyRatingRequest = input;

            return videosService.getMyVideoRating(input);
          },
          rateVideo: async (input) => {
            receivedRateVideoRequest = input;

            return videosService.rateVideo(input);
          },
          getHlsMaster: async (input) => {
            receivedHlsMasterRequest = input;

            return {
              playlist: `#EXTM3U\n/videos/${input.publicId}/hls/${generationId}/480p/index.m3u8\n`,
            };
          },
          getHlsRendition: async (input) => {
            receivedHlsRenditionRequest = input;

            return videosService.getHlsRendition(input);
          },
          getHlsSegment: async (input) => {
            receivedHlsSegmentRequest = input;

            return videosService.getHlsSegment(input);
          },
          getThumbnail: async (input) => {
            receivedThumbnailReadRequest = input;

            return videosService.getThumbnail(input);
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
          uploadSourceThumbnail: async (input) => {
            receivedThumbnailRequest = input;

            return videosService.uploadSourceThumbnail(input);
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
        title: 'Me at the zoo',
        description: '00:00 Intro 00:05 The cool thing 00:17 End.',
        tags: ['zoo', 'elephants', 'zoo'],
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
      title: 'Me at the zoo',
      description: '00:00 Intro 00:05 The cool thing 00:17 End.',
      tags: ['zoo', 'elephants'],
      license: 'all_rights_reserved',
      visibility: 'public',
      allowComments: false,
    });
    expect(await response.json()).toMatchObject({
      video: {
        ownerId: authenticatedUserId,
        title: 'Me at the zoo',
        description: '00:00 Intro 00:05 The cool thing 00:17 End.',
        tags: ['zoo', 'elephants'],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: false,
        processingStatus: 'draft',
        moderationStatus: 'pending',
      },
    });
  });

  test('accepts every supported video license', async () => {
    for (const license of VIDEO_LICENSES) {
      receivedCreateRequest = undefined;

      const response = await fetch(`${baseUrl}/videos`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer route-session-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `Video licensed as ${license}`,
          license,
        }),
      });

      expect(response.status).toBe(201);
      const observedCreateRequest = receivedCreateRequest as CreateVideoInput | undefined;
      expect(observedCreateRequest?.license).toBe(license);
    }
  });

  test('rejects unsupported video licenses before calling the service', async () => {
    receivedCreateRequest = undefined;

    const response = await fetch(`${baseUrl}/videos`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Unsupported license',
        license: 'public_domain',
      }),
    });

    expect(response.status).toBe(400);
    expect(receivedCreateRequest).toBeUndefined();
    expect(await response.json()).toMatchObject({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
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
        title: 'Me at the zoo',
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

  test('searches public videos without authentication using stable pagination input', async () => {
    receivedPublicSearchRequest = undefined;
    receivedSessionKey = undefined;
    const query = new URLSearchParams({
      search: '  launch recap  ',
      sort: 'oldest',
      limit: '10',
      cursorCreatedAt: '2026-01-01T00:00:00.000Z',
      cursorPublicId: publicId,
    });

    const response = await fetch(`${baseUrl}/videos/search?${query.toString()}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(receivedSessionKey).toBeUndefined();
    const observedPublicSearchRequest = receivedPublicSearchRequest as
      | SearchPublicVideosInput
      | undefined;
    expect(observedPublicSearchRequest).toEqual({
      search: 'launch recap',
      sort: 'oldest',
      limit: 10,
      cursor: {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        publicId,
      },
    });
    expect(await response.json()).toEqual({
      videos: [
        {
          publicId: 'AbCdEf123_',
          title: 'Me at the zoo',
          description: '00:00 Intro 00:05 The cool thing 00:17 End.',
          tags: ['zoo', 'elephants'],
          username: 'jawed',
          thumbnailPath: '/videos/AbCdEf123_/thumbnail',
          ratingAverage: 4.5,
          ratingCount: 2,
          publishedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      total: 1,
      nextCursor: null,
    });
  });

  test('rejects invalid public video searches before calling the service', async () => {
    for (const query of [
      '',
      '?search=x',
      `?search=valid&cursorCreatedAt=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`,
      '?search=%00x',
    ]) {
      receivedPublicSearchRequest = undefined;

      const response = await fetch(`${baseUrl}/videos/search${query}`);

      expect(response.status).toBe(400);
      expect(receivedPublicSearchRequest).toBeUndefined();
      expect(await response.json()).toMatchObject({
        error: 'ValidationError',
        message: REQUEST_VALIDATION_FAILED_MESSAGE,
      });
    }
  });

  test('serves an anonymous public video detail through a strict no-store response', async () => {
    receivedPublicVideoDetailRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/${publicId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(receivedSessionKey).toBeUndefined();
    const observedAnonymousDetailRequest = receivedPublicVideoDetailRequest as
      | GetPublicVideoDetailInput
      | undefined;
    expect(observedAnonymousDetailRequest).toEqual({ publicId });
    const body = (await response.json()) as { video: Record<string, unknown> };
    expect(body).toEqual({
      video: {
        publicId,
        title: 'Me at the zoo',
        description: '00:00 Intro 00:05 The cool thing 00:17 End.',
        tags: ['zoo', 'elephants'],
        license: 'all_rights_reserved',
        visibility: 'public',
        createdAt: '2026-01-01T00:00:00.000Z',
        publishedAt: '2026-01-01T00:00:00.000Z',
        creator: {
          username: 'jawed',
          displayName: 'Jawed Karim',
          avatarUrl: '/profiles/jawed/avatar',
        },
        ratingAverage: 4.5,
        ratingCount: 2,
        userRating: null,
        viewCount: 128,
        hlsMasterPath: `/videos/${publicId}/hls/master.m3u8`,
      },
    });
    for (const forbidden of [
      'id',
      'ownerId',
      'moderationStatus',
      'processingStatus',
      'thumbnailObjectKey',
      'hlsMasterObjectKey',
      'rejectionReason',
      'bucket',
      'objectKey',
    ]) {
      expect(body.video).not.toHaveProperty(forbidden);
    }
  });

  test('includes the current rating with valid optional auth and degrades invalid auth to anonymous', async () => {
    receivedPublicVideoDetailRequest = undefined;
    receivedSessionKey = undefined;
    const authenticatedResponse = await fetch(`${baseUrl}/videos/${publicId}`, {
      headers: { Authorization: 'Bearer route-session-key' },
    });

    expect(authenticatedResponse.status).toBe(200);
    const observedAuthenticatedSessionKey = receivedSessionKey as string | undefined;
    const observedAuthenticatedDetailRequest = receivedPublicVideoDetailRequest as
      | GetPublicVideoDetailInput
      | undefined;
    expect(observedAuthenticatedSessionKey).toBe('route-session-key');
    expect(observedAuthenticatedDetailRequest).toEqual({
      publicId,
      userId: authenticatedUserId,
    });
    expect((await authenticatedResponse.json()) as unknown).toEqual(
      expect.objectContaining({
        video: expect.objectContaining({ userRating: 5 }),
      }),
    );

    receivedPublicVideoDetailRequest = undefined;
    receivedSessionKey = undefined;
    const invalidResponse = await fetch(`${baseUrl}/videos/${publicId}`, {
      headers: { Authorization: 'Bearer invalid-session-key' },
    });

    expect(invalidResponse.status).toBe(200);
    const observedInvalidSessionKey = receivedSessionKey as string | undefined;
    const observedInvalidDetailRequest = receivedPublicVideoDetailRequest as
      | GetPublicVideoDetailInput
      | undefined;
    expect(observedInvalidSessionKey).toBe('invalid-session-key');
    expect(observedInvalidDetailRequest).toEqual({ publicId });
    expect((await invalidResponse.json()) as unknown).toEqual(
      expect.objectContaining({
        video: expect.objectContaining({ userRating: null }),
      }),
    );
  });

  test('rejects a malformed detail public id before authentication or service access', async () => {
    receivedPublicVideoDetailRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/not-valid`);

    expect(response.status).toBe(400);
    expect(receivedSessionKey).toBeUndefined();
    expect(receivedPublicVideoDetailRequest).toBeUndefined();
  });

  test('separates public rating aggregates from authenticated current-user ratings', async () => {
    receivedPublicRatingRequest = undefined;
    receivedMyRatingRequest = undefined;
    receivedRateVideoRequest = undefined;
    receivedSessionKey = undefined;

    const publicResponse = await fetch(`${baseUrl}/videos/${publicId}/rating`);

    expect(publicResponse.status).toBe(200);
    expect(receivedSessionKey).toBeUndefined();
    expect(receivedPublicRatingRequest as GetVideoRatingInput | undefined).toEqual({ publicId });
    expect(await publicResponse.json()).toEqual({ ratingAverage: 4.5, ratingCount: 2 });

    const myResponse = await fetch(`${baseUrl}/videos/${publicId}/rating/me`, {
      headers: { Authorization: 'Bearer route-session-key' },
    });

    expect(myResponse.status).toBe(200);
    expect(receivedMyRatingRequest as GetMyVideoRatingInput | undefined).toEqual({
      userId: authenticatedUserId,
      publicId,
    });
    expect(await myResponse.json()).toEqual({
      ratingAverage: 4.5,
      ratingCount: 2,
      userRating: 5,
    });

    const putResponse = await fetch(`${baseUrl}/videos/${publicId}/rating`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 4 }),
    });

    expect(putResponse.status).toBe(200);
    expect(receivedRateVideoRequest as RateVideoInput | undefined).toEqual({
      userId: authenticatedUserId,
      publicId,
      value: 4,
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
        title: 'Me at the zoo',
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

  test('serves public HLS playlists and segment redirects without authentication', async () => {
    receivedHlsMasterRequest = undefined;
    receivedHlsRenditionRequest = undefined;
    receivedHlsSegmentRequest = undefined;
    receivedSessionKey = undefined;

    const masterResponse = await fetch(`${baseUrl}/videos/${publicId}/hls/master.m3u8`);

    expect(masterResponse.status).toBe(200);
    expect(masterResponse.headers.get('cache-control')).toBe('no-cache');
    expect(masterResponse.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    const observedMasterRequest = receivedHlsMasterRequest as GetVideoHlsMasterInput | undefined;
    expect(observedMasterRequest).toEqual({ publicId });
    expect(await masterResponse.text()).toContain(`/${generationId}/480p/index.m3u8`);

    const renditionResponse = await fetch(
      `${baseUrl}/videos/${publicId}/hls/${generationId}/480p/index.m3u8`,
    );

    expect(renditionResponse.status).toBe(200);
    expect(renditionResponse.headers.get('cache-control')).toBe('no-cache');
    expect(renditionResponse.headers.get('content-type')).toContain(
      'application/vnd.apple.mpegurl',
    );
    const observedRenditionRequest = receivedHlsRenditionRequest as
      | GetVideoHlsRenditionInput
      | undefined;
    expect(observedRenditionRequest).toEqual({
      publicId,
      generationId,
      quality: '480p',
    });

    const segmentResponse = await fetch(
      `${baseUrl}/videos/${publicId}/hls/${generationId}/480p/segments/segment-00000.ts`,
      {
        redirect: 'manual',
      },
    );

    expect(segmentResponse.status).toBe(307);
    expect(segmentResponse.headers.get('cache-control')).toBe('no-store');
    expect(segmentResponse.headers.get('location')).toBe(
      'http://localhost:9000/videos/segment-00000.ts?signature=test',
    );
    const observedSegmentRequest = receivedHlsSegmentRequest as GetVideoHlsSegmentInput | undefined;
    expect(observedSegmentRequest).toEqual({
      publicId,
      generationId,
      quality: '480p',
      segment: 'segment-00000.ts',
    });
    expect(receivedSessionKey).toBeUndefined();
  });

  test('redirects public thumbnail reads without authentication or response caching', async () => {
    receivedThumbnailReadRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/${publicId}/thumbnail`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBe(
      'http://localhost:9000/videos/thumbnail/poster.webp?signature=test',
    );
    const observedThumbnailReadRequest = receivedThumbnailReadRequest as
      | GetVideoThumbnailInput
      | undefined;
    expect(observedThumbnailReadRequest).toEqual({ publicId });
    expect(receivedSessionKey).toBeUndefined();
  });

  test('initializes a multipart upload with an authenticated session', async () => {
    receivedInitRequest = undefined;
    receivedSessionKey = undefined;

    const response = await fetch(`${baseUrl}/videos/${videoId}/upload/multipart/init`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sizeBytes: 67_108_864 }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedInitRequest = receivedInitRequest as InitVideoMultipartUploadInput | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedInitRequest).toEqual({
      userId: authenticatedUserId,
      videoId,
      sizeBytes: 67_108_864,
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

  test('rejects invalid declared upload sizes before calling the service', async () => {
    receivedInitRequest = undefined;

    const response = await fetch(`${baseUrl}/videos/${videoId}/upload/multipart/init`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer route-session-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sizeBytes: 0 }),
    });

    expect(response.status).toBe(400);
    expect(receivedInitRequest).toBeUndefined();
    expect(await response.json()).toMatchObject({
      error: 'ValidationError',
      message: REQUEST_VALIDATION_FAILED_MESSAGE,
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
          url: `http://localhost:9000/videos/user-id/video-id/sources/${uploadSessionId}/original.mp4?partNumber=1&uploadId=test-upload-id`,
        },
      ],
    });
  });

  test('uploads a source thumbnail through the authenticated bounded multipart route', async () => {
    receivedThumbnailRequest = undefined;
    receivedSessionKey = undefined;
    const thumbnailBytes = new Uint8Array([1, 2, 3, 4]);
    const body = new FormData();
    body.set('thumbnail', new Blob([thumbnailBytes], { type: 'image/png' }), 'thumbnail.png');

    const response = await fetch(
      `${baseUrl}/videos/${videoId}/upload/multipart/${uploadSessionId}/thumbnail`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer route-session-key',
        },
        body,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const observedSessionKey = receivedSessionKey as string | undefined;
    const observedThumbnailRequest = receivedThumbnailRequest as
      | UploadVideoSourceThumbnailInput
      | undefined;
    expect(observedSessionKey).toBe('route-session-key');
    expect(observedThumbnailRequest).toMatchObject({
      userId: authenticatedUserId,
      videoId,
      uploadSessionId,
      file: {
        size: thumbnailBytes.length,
      },
    });
    expect(observedThumbnailRequest?.file.buffer).toEqual(Buffer.from(thumbnailBytes));
    expect(await response.json()).toMatchObject({
      thumbnail: {
        uploadSessionId,
        mimeType: 'image/webp',
        sizeBytes: thumbnailBytes.length,
        width: 1280,
        height: 720,
      },
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
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sizeBytes: 67_108_864 }),
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
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sizeBytes: 67_108_864 }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'NotFound',
      message: 'Video not found',
    });
  });
});
