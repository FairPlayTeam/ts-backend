import { describe, expect, test } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { jsonResponse } from '../src/docs/openapi.helpers.js';
import { generateOpenApi } from '../src/docs/openapi.js';
import type { RouteDoc } from '../src/docs/registry.js';
import { z } from '../src/docs/zod.js';
import { discoverRouteFiles } from '../src/routing/loadRoutes.js';
import { AUTH_ROLES } from '../src/services/auth.roles.js';
import { VIDEO_LICENSES } from '../src/services/videos/videoLicenses.js';
import { createStubAdminService } from './support/admin.js';
import { createStubAuthService } from './support/auth.js';
import { createStubProfilesService } from './support/profiles.js';
import { createStubVideosService } from './support/videos.js';

const documentedHttpMethods = new Set(['delete', 'get', 'patch', 'post', 'put']);

type RuntimeRouteLayer = {
  handle?: {
    stack?: RuntimeRouteLayer[];
  };
  route?: {
    methods?: Record<string, boolean>;
    path?: unknown;
  };
};

type ExpressWithRouterStack = {
  _router?: { stack?: RuntimeRouteLayer[] };
  router?: { stack?: RuntimeRouteLayer[] };
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, { operationId?: unknown }>>;
};

const createOpenApiTestApp = () =>
  createApp(
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
      authService: createStubAuthService(),
      profilesService: createStubProfilesService(),
      videosService: createStubVideosService(),
    },
  );

const normalizeRoutePath = (path: string): string => {
  const normalized = `/${path.split('/').filter(Boolean).join('/')}`;

  return normalized === '/' ? '/' : normalized.replace(/\/$/, '');
};

const joinRoutePaths = (basePath: string, routePath: string): string =>
  normalizeRoutePath(`${basePath}/${routePath}`);

const toOpenApiRoutePath = (path: string): string =>
  normalizeRoutePath(path).replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const formatRouteOperation = (method: string, path: string): string =>
  `${method.toUpperCase()} ${toOpenApiRoutePath(path)}`;

const toRoutePathList = (path: unknown): string[] => {
  if (typeof path === 'string') {
    return [path];
  }

  if (Array.isArray(path)) {
    return path.filter((entry): entry is string => typeof entry === 'string');
  }

  return [];
};

const getRuntimeRouterLayers = (
  app: Awaited<ReturnType<typeof createOpenApiTestApp>>,
): RuntimeRouteLayer[] => {
  const { _router, router } = app as unknown as ExpressWithRouterStack;
  const stack = router?.stack ?? _router?.stack ?? [];

  return stack.filter((layer) =>
    layer.handle?.stack?.some((child: RuntimeRouteLayer) => child.route),
  );
};

const getRuntimeRouteOperations = async (
  app: Awaited<ReturnType<typeof createOpenApiTestApp>>,
): Promise<string[]> => {
  const routeFiles = await discoverRouteFiles(new URL('../src/routes/', import.meta.url));
  const routerLayers = getRuntimeRouterLayers(app);

  expect(routerLayers).toHaveLength(routeFiles.length);

  const operations = routerLayers.flatMap((routerLayer, index) => {
    const routeFile = routeFiles[index];

    if (!routeFile) {
      return [];
    }

    return (routerLayer.handle?.stack ?? []).flatMap((routeLayer) => {
      const methods = Object.entries(routeLayer.route?.methods ?? {})
        .filter(([method, enabled]) => enabled && documentedHttpMethods.has(method))
        .map(([method]) => method);

      return toRoutePathList(routeLayer.route?.path).flatMap((routePath) =>
        methods.map((method) =>
          formatRouteOperation(method, joinRoutePaths(routeFile.routePath, routePath)),
        ),
      );
    });
  });

  return operations.sort();
};

const getOpenApiRouteOperations = (document: OpenApiDocument): string[] =>
  Object.entries(document.paths ?? {})
    .flatMap(([path, pathItem]) =>
      Object.keys(pathItem)
        .filter((method) => documentedHttpMethods.has(method))
        .map((method) => formatRouteOperation(method, path)),
    )
    .sort();

const getOpenApiOperationIds = (document: OpenApiDocument): unknown[] =>
  Object.values(document.paths ?? {}).flatMap((pathItem) =>
    Object.entries(pathItem)
      .filter(([method]) => documentedHttpMethods.has(method))
      .map(([, operation]) => operation.operationId),
  );

describe('OpenAPI generation', () => {
  test('includes auto-loaded routes and Zod request schemas', async () => {
    const app = await createOpenApiTestApp();

    const response = await request(app).get('/openapi.json').expect(200);
    const document = response.body;

    expect(JSON.stringify(document)).not.toContain('thumbnailObjectKey');
    expect(JSON.stringify(document)).not.toContain('user-media/users/');

    expect(Object.keys(document.paths).sort()).toEqual([
      '/',
      '/admin/users',
      '/admin/users/{userId}/ban',
      '/admin/users/{userId}/role',
      '/admin/users/{userId}/unban',
      '/auth/forgot-password',
      '/auth/login',
      '/auth/me',
      '/auth/me/avatar',
      '/auth/me/banner',
      '/auth/me/export',
      '/auth/register',
      '/auth/resend-verification',
      '/auth/reset-password',
      '/auth/sessions',
      '/auth/sessions/all',
      '/auth/sessions/others/all',
      '/auth/sessions/{sessionId}',
      '/auth/verify-email',
      '/health',
      '/health/live',
      '/health/ready',
      '/moderation/videos',
      '/moderation/videos/{videoId}/moderation',
      '/profiles/me/following',
      '/profiles/{username}',
      '/profiles/{username}/avatar',
      '/profiles/{username}/banner',
      '/profiles/{username}/follow',
      '/profiles/{username}/videos',
      '/videos',
      '/videos/me',
      '/videos/search',
      '/videos/{publicId}',
      '/videos/{publicId}/comments',
      '/videos/{publicId}/comments/{commentId}',
      '/videos/{publicId}/comments/{commentId}/like',
      '/videos/{publicId}/comments/{rootCommentId}/replies',
      '/videos/{publicId}/hls/master.m3u8',
      '/videos/{publicId}/hls/{generationId}/{quality}/index.m3u8',
      '/videos/{publicId}/hls/{generationId}/{quality}/segments/{segment}',
      '/videos/{publicId}/rating',
      '/videos/{publicId}/rating/me',
      '/videos/{publicId}/thumbnail',
      '/videos/{videoId}/upload/multipart/init',
      '/videos/{videoId}/upload/multipart/{uploadSessionId}',
      '/videos/{videoId}/upload/multipart/{uploadSessionId}/abort',
      '/videos/{videoId}/upload/multipart/{uploadSessionId}/complete',
      '/videos/{videoId}/upload/multipart/{uploadSessionId}/parts/sign',
      '/videos/{videoId}/upload/multipart/{uploadSessionId}/thumbnail',
    ]);
    expect(document.paths['/moderation/videos']?.get?.tags).toEqual(['Moderation']);
    expect(document.paths['/moderation/videos/{videoId}/moderation']?.post?.tags).toEqual([
      'Moderation',
    ]);
    expect(document.paths['/videos/search']?.get?.tags).toEqual(['Videos']);
    expect(document.paths['/videos/search']?.get?.security).toEqual([]);
    expect(document.paths['/videos/search']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'search',
          in: 'query',
          required: true,
        }),
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'sort',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorCreatedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorPublicId',
          in: 'query',
        }),
      ]),
    );
    expect(document.paths['/videos/search']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/videos/search']?.get?.responses?.[400]).toBeDefined();
    expect(document.paths['/videos/search']?.get?.responses?.[401]).toBeUndefined();
    expect(document.components.schemas.PublicProfileIdentity).toMatchObject({
      type: 'object',
      required: ['username', 'displayName', 'avatarUrl'],
    });
    expect(
      Object.keys(document.components.schemas.PublicProfileIdentity.properties).sort(),
    ).toEqual(['avatarUrl', 'displayName', 'username']);
    expect(document.components.schemas.PublicCreatorSearchSummary.allOf[0]).toEqual({
      $ref: '#/components/schemas/PublicProfileIdentity',
    });
    expect(
      Object.keys(
        document.components.schemas.PublicCreatorSearchSummary.allOf[1].properties,
      ).sort(),
    ).toEqual(['createdAt', 'followerCount', 'videoCount']);
    expect(document.components.schemas.PublicProfileIdentity.properties.displayName).toMatchObject({
      type: 'string',
      nullable: true,
    });
    expect(document.components.schemas.PublicVideoSearchResponse.properties.creators).toMatchObject(
      {
        type: 'array',
        maxItems: 10,
        items: {
          $ref: '#/components/schemas/PublicCreatorSearchSummary',
        },
      },
    );
    expect(document.components.schemas.PublicVideoSearchResponse.properties.total).toMatchObject({
      description: 'Total number of matching videos. Creator matches are not included.',
    });
    expect(
      document.components.schemas.PublicVideoSearchResponse.properties.nextCursor,
    ).toMatchObject({
      description: 'Cursor for the next page of videos. Creator matches are not paginated.',
    });
    expect(document.paths['/profiles/{username}/videos']?.get?.security).toEqual([]);
    expect(document.paths['/profiles/{username}/videos']?.get?.responses?.[404]).toBeDefined();
    expect(
      document.paths['/profiles/{username}/videos']?.get?.responses?.[200]?.content?.[
        'application/json'
      ]?.schema,
    ).toEqual(
      document.paths['/videos']?.get?.responses?.[200]?.content?.['application/json']?.schema,
    );
    expect(document.paths['/videos/{publicId}']?.get?.security).toEqual([{}, { bearerAuth: [] }]);
    expect(document.paths['/videos/{publicId}']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/videos/{publicId}']?.get?.responses?.[404]).toBeDefined();
    expect(document.paths['/videos/{publicId}']?.get?.responses?.[401]).toBeUndefined();
    expect(document.paths['/videos/{publicId}/comments']?.get?.security).toEqual([
      {},
      { bearerAuth: [] },
    ]);
    expect(document.paths['/videos/{publicId}/comments']?.get).toMatchObject({
      summary: 'List public comment threads for a video',
      description: expect.stringContaining('Authentication is optional'),
    });
    expect(
      document.paths['/videos/{publicId}/comments/{rootCommentId}/replies']?.get?.security,
    ).toEqual([{}, { bearerAuth: [] }]);
    expect(
      document.paths['/videos/{publicId}/comments/{rootCommentId}/replies']?.get,
    ).toMatchObject({
      summary: 'List public replies to a video comment',
      description: expect.stringContaining('Authentication is optional'),
    });
    expect(
      document.paths['/videos/{publicId}/comments/{commentId}/like']?.put?.responses?.[503]
        ?.description,
    ).toBe('Comment like mutation temporarily unavailable');
    expect(document.paths['/videos/{publicId}/comments/{commentId}/like']?.put).toMatchObject({
      summary: 'Like a video comment',
      description: expect.stringContaining('idempotent'),
      responses: {
        204: {
          description: 'The comment is liked by the current user',
        },
      },
    });
    expect(document.paths['/videos/{publicId}/comments/{commentId}/like']?.delete).toMatchObject({
      summary: 'Unlike a video comment',
      description: expect.stringContaining('remains available'),
      responses: {
        204: {
          description: "The current user's like was removed or was already absent",
        },
      },
    });
    expect(document.paths['/videos/{publicId}/rating']?.get?.security).toEqual([]);
    expect(document.paths['/videos/{publicId}/rating']?.get?.responses?.[401]).toBeUndefined();
    expect(document.paths['/videos/{publicId}/rating']?.get?.responses?.[403]).toBeUndefined();
    expect(document.paths['/videos/{publicId}/rating/me']?.get?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/videos/{publicId}/rating/me']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/videos/{publicId}/rating/me']?.get?.responses?.[403]).toBeUndefined();
    expect(document.paths['/videos/{publicId}/rating']?.put?.responses?.[403]).toBeDefined();
    expect(document.paths['/videos/{publicId}/rating']?.put?.responses?.[503]).toBeDefined();
    expect(document.paths['/videos/{publicId}/rating']?.put?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'publicId',
          in: 'path',
          required: true,
        }),
      ]),
    );
    expect(document.paths['/videos/{publicId}/hls/master.m3u8']?.get?.security).toEqual([]);
    expect(document.paths['/profiles/{username}/avatar']?.get?.security).toEqual([]);
    expect(document.paths['/profiles/{username}/banner']?.get?.security).toEqual([]);
    expect(
      document.paths['/profiles/{username}/avatar']?.get?.responses?.[200]?.content?.['image/webp'],
    ).toBeDefined();
    expect(document.paths['/profiles/{username}']?.get?.responses?.[503]).toBeUndefined();
    expect(document.paths['/videos/{publicId}/thumbnail']?.get?.security).toEqual([]);
    expect(document.paths['/videos/{publicId}/thumbnail']?.get?.responses?.[307]).toBeDefined();
    expect(
      document.paths['/videos/{publicId}/hls/master.m3u8']?.get?.responses?.[200]?.content?.[
        'application/vnd.apple.mpegurl'
      ],
    ).toBeDefined();
    expect(
      document.paths['/videos/{publicId}/hls/{generationId}/{quality}/segments/{segment}']?.get
        ?.responses?.[307],
    ).toBeDefined();
    expect(
      document.paths['/videos/{publicId}/hls/{generationId}/{quality}/index.m3u8']?.get?.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          in: 'path',
          name: 'quality',
          required: true,
          schema: expect.objectContaining({
            enum: ['240p', '480p', '720p', '1080p'],
          }),
        }),
      ]),
    );
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}/thumbnail']?.put
        ?.requestBody?.content?.['multipart/form-data'],
    ).toBeDefined();
    expect(document.paths['/auth/login']?.post?.requestBody).toBeDefined();
    expect(document.paths['/admin/users']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/admin/users']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'search',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'banStatus',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorCreatedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorId',
          in: 'query',
        }),
      ]),
    );
    expect(
      document.paths['/admin/users']?.get?.parameters?.find(
        (parameter: { name?: string }) => parameter.name === 'banStatus',
      )?.schema,
    ).toEqual(
      expect.objectContaining({
        enum: ['allUsers', 'banned', 'notbanned'],
      }),
    );
    expect(document.paths['/admin/users']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/admin/users']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/admin/users']?.get?.responses?.[400]).toBeDefined();
    expect(document.paths['/admin/users']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/admin/users']?.get?.responses?.[403]).toBeDefined();
    expect(document.paths['/admin/users']?.get?.responses?.[503]).toBeUndefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.requestBody).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/admin/users/{userId}/ban']?.post?.parameters).toEqual([
      expect.objectContaining({
        name: 'userId',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[400]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[403]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[404]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/ban']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.requestBody).toBeUndefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/admin/users/{userId}/unban']?.post?.parameters).toEqual([
      expect.objectContaining({
        name: 'userId',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[400]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[403]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[404]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/unban']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.requestBody).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/admin/users/{userId}/role']?.patch?.parameters).toEqual([
      expect.objectContaining({
        name: 'userId',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[200]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[400]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[401]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[403]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[404]).toBeDefined();
    expect(document.paths['/admin/users/{userId}/role']?.patch?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/login']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/login']?.post?.responses?.[403]).toBeDefined();
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'Session key',
      description: 'Paste the sessionKey returned by /auth/login or /auth/verify-email.',
    });
    expect(document.paths['/auth/me']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me']?.get?.responses?.[404]).toBeDefined();
    expect(document.paths['/auth/me']?.get?.responses?.[503]).toBeUndefined();
    expect(document.paths['/auth/me']?.patch?.requestBody).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.patch?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me']?.patch?.responses?.[404]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.requestBody).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.responses?.[200]?.description).toBe(
      'Account deletion result',
    );
    expect(document.paths['/auth/me']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.requestBody?.content).toHaveProperty(
      'multipart/form-data',
    );
    expect(document.paths['/auth/me/avatar']?.put?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[404]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.put?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me/avatar']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/avatar']?.delete?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.requestBody?.content).toHaveProperty(
      'multipart/form-data',
    );
    expect(document.paths['/auth/me/banner']?.put?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/banner']?.put?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[404]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.put?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/me/banner']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/banner']?.delete?.responses?.[503]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/me/export']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[404]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/me/export']?.post?.responses?.[503]).toBeDefined();
    const userDataExportSchema = JSON.stringify(
      document.components?.schemas?.UserDataExportResponse,
    );
    expect(userDataExportSchema).toContain('"url"');
    expect(userDataExportSchema).not.toContain('objectKey');
    expect(userDataExportSchema).not.toContain('"bucket"');
    expect(document.paths['/auth/sessions']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorLastUsedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorId',
          in: 'query',
        }),
      ]),
    );
    expect(document.paths['/auth/sessions']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.requestBody).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.requestBody).toEqual(
      document.paths['/auth/sessions/all']?.delete?.requestBody,
    );
    expect(document.paths['/auth/sessions/others/all']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/sessions/others/all']?.delete?.responses?.[403]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.parameters).toEqual([
      expect.objectContaining({
        name: 'sessionId',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/auth/sessions/{sessionId}']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/auth/register']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/register']?.post?.responses?.[413]).toBeDefined();
    expect(document.paths['/auth/forgot-password']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/forgot-password']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/forgot-password']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/forgot-password']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/reset-password']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/reset-password']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.security).toBeUndefined();
    expect(document.paths['/auth/resend-verification']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/auth/resend-verification']?.post?.responses?.[409]).toBeDefined();
    expect(document.paths['/auth/verify-email']?.post?.requestBody).toBeDefined();
    expect(document.paths['/auth/verify-email']?.post?.responses?.[400]).toBeDefined();
    expect(
      document.paths['/auth/verify-email']?.post?.responses?.[400]?.content?.['application/json']
        ?.schema,
    ).toEqual({
      $ref: '#/components/schemas/ApiOrValidationError',
    });
    expect(document.paths['/profiles/me/following']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/profiles/me/following']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/profiles/me/following']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorFollowedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorId',
          in: 'query',
        }),
      ]),
    );
    expect(document.paths['/profiles/me/following']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/profiles/me/following']?.get?.responses?.[400]).toBeDefined();
    expect(document.paths['/profiles/me/following']?.get?.responses?.[401]).toBeDefined();
    expect(document.paths['/profiles/me/following']?.get?.responses?.[503]).toBeUndefined();
    expect(document.paths['/profiles/{username}']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/profiles/{username}']?.get?.security).toEqual([{}, { bearerAuth: [] }]);
    expect(document.paths['/profiles/{username}']?.get?.parameters).toEqual([
      expect.objectContaining({
        name: 'username',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/profiles/{username}']?.get?.parameters?.[0]?.schema).toEqual(
      expect.objectContaining({
        pattern: '^[A-Za-z0-9_]+$',
      }),
    );
    expect(document.paths['/profiles/{username}']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/profiles/{username}']?.get?.responses?.[400]).toBeDefined();
    expect(document.paths['/profiles/{username}']?.get?.responses?.[404]).toBeDefined();
    expect(document.paths['/profiles/{username}']?.get?.responses?.[503]).toBeUndefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.requestBody).toBeUndefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/profiles/{username}/follow']?.post?.parameters).toEqual([
      expect.objectContaining({
        name: 'username',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/profiles/{username}/follow']?.post?.responses?.[200]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.responses?.[400]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.responses?.[401]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.responses?.[404]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.post?.responses?.[503]).toBeUndefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.requestBody).toBeUndefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/profiles/{username}/follow']?.delete?.parameters).toEqual([
      expect.objectContaining({
        name: 'username',
        in: 'path',
        required: true,
      }),
    ]);
    expect(document.paths['/profiles/{username}/follow']?.delete?.responses?.[200]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.responses?.[400]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.responses?.[401]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.responses?.[404]).toBeDefined();
    expect(document.paths['/profiles/{username}/follow']?.delete?.responses?.[503]).toBeUndefined();
    expect(document.paths['/videos']?.post?.requestBody?.content).toHaveProperty(
      'application/json',
    );
    expect(document.paths['/videos']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/videos']?.post?.responses?.[201]).toBeDefined();
    expect(document.paths['/videos/me']?.get?.requestBody).toBeUndefined();
    expect(document.paths['/videos/me']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/videos/me']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorCreatedAt',
          in: 'query',
        }),
        expect.objectContaining({
          name: 'cursorId',
          in: 'query',
        }),
      ]),
    );
    expect(document.paths['/videos/me']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/videos/me']?.get?.responses?.[400]).toBeDefined();
    expect(document.paths['/videos/me']?.get?.responses?.[401]).toBeDefined();
    expect(
      document.paths['/videos/{videoId}/upload/multipart/init']?.post?.requestBody,
    ).toBeDefined();
    expect(
      document.paths['/videos/{videoId}/upload/multipart/init']?.post?.requestBody?.content,
    ).toHaveProperty('application/json');
    expect(document.paths['/videos/{videoId}/upload/multipart/init']?.post?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(
      document.paths['/videos/{videoId}/upload/multipart/init']?.post?.responses?.[201],
    ).toBeDefined();
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}/parts/sign']?.post
        ?.requestBody,
    ).toBeDefined();
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}/parts/sign']?.post
        ?.requestBody?.content,
    ).toHaveProperty('application/json');
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}/complete']?.post
        ?.requestBody?.content,
    ).toHaveProperty('application/json');
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}/abort']?.post
        ?.requestBody,
    ).toBeUndefined();
    expect(
      document.paths['/videos/{videoId}/upload/multipart/{uploadSessionId}']?.get?.requestBody,
    ).toBeUndefined();
    expect(document.components?.schemas?.LoginRequest).toBeDefined();
    expect(document.components?.schemas?.LoginResponse).toBeDefined();
    expect(document.components?.schemas?.LoginResponse?.properties?.user?.properties?.role).toEqual(
      {
        type: 'string',
        enum: [...AUTH_ROLES],
        example: 'user',
      },
    );
    expect(document.components?.schemas?.CurrentUserResponse).toBeDefined();
    expect(document.components?.schemas?.AdminAccountsResponse).toBeDefined();
    expect(document.components?.schemas?.BanAdminAccountRequest).toBeDefined();
    expect(document.components?.schemas?.BanAdminAccountResponse).toBeDefined();
    expect(document.components?.schemas?.UnbanAdminAccountResponse).toBeDefined();
    expect(document.components?.schemas?.UpdateAdminAccountRoleRequest).toBeDefined();
    expect(document.components?.schemas?.UpdateAdminAccountRoleResponse).toBeDefined();
    expect(document.components?.schemas?.PublicProfileResponse).toBeDefined();
    expect(document.components?.schemas?.FollowPublicProfileResponse).toBeDefined();
    expect(document.components?.schemas?.FollowingProfilesResponse).toBeDefined();
    expect(document.components?.schemas?.UnfollowPublicProfileResponse).toBeDefined();
    expect(document.components?.schemas?.CreateVideoRequest).toBeDefined();
    expect(document.components?.schemas?.CreateVideoRequest?.properties?.license).toEqual({
      type: 'string',
      enum: [...VIDEO_LICENSES],
      default: 'all_rights_reserved',
      example: 'all_rights_reserved',
    });
    expect(document.components?.schemas?.CreateVideoRequest?.properties?.allowComments).toEqual({
      type: 'boolean',
      description:
        'Whether comments are allowed on this video. Defaults to true and is fixed at creation in this API version.',
      default: true,
      example: true,
    });
    expect(document.components?.schemas?.CreateVideoRequest?.required ?? []).not.toContain(
      'allowComments',
    );
    expect(document.components?.schemas?.CreateVideoResponse).toBeDefined();
    expect(document.components?.schemas?.MyVideosResponse).toBeDefined();
    expect(document.components?.schemas?.VideoUploadSessionResponse).toBeDefined();
    expect(document.components?.schemas?.SignVideoMultipartUploadPartsRequest).toBeDefined();
    expect(document.components?.schemas?.SignedVideoUploadPartsResponse).toBeDefined();
    expect(document.components?.schemas?.CompleteVideoMultipartUploadRequest).toBeDefined();
    expect(
      document.components?.schemas?.CurrentUserResponse?.properties?.user?.properties?.avatarUrl,
    ).toBeDefined();
    expect(
      document.components?.schemas?.CurrentUserResponse?.properties?.user?.properties?.bannerUrl,
    ).toBeDefined();
    expect(document.components?.schemas?.ApiOrValidationError).toBeDefined();
    expect(document.components?.schemas?.UpdateProfileRequest).toBeDefined();
    expect(document.components?.schemas?.UpdateProfileResponse).toBeDefined();
    expect(document.components?.schemas?.UploadAvatarRequest).toBeDefined();
    expect(document.components?.schemas?.UploadAvatarResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteAvatarResponse).toBeDefined();
    expect(document.components?.schemas?.UploadBannerRequest).toBeDefined();
    expect(document.components?.schemas?.UploadBannerResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteBannerResponse).toBeDefined();
    expect(document.components?.schemas?.DeleteAccountResponse).toBeDefined();
    expect(document.components?.schemas?.RegisterRequest).toBeDefined();
    expect(document.components?.schemas?.RegisterResponse).toBeDefined();
    expect(document.components?.schemas?.RequestPasswordResetRequest).toBeDefined();
    expect(document.components?.schemas?.RequestPasswordResetResponse).toBeDefined();
    expect(document.components?.schemas?.ResetPasswordRequest).toBeDefined();
    expect(document.components?.schemas?.ResetPasswordResponse).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationRequest).toBeDefined();
    expect(document.components?.schemas?.ResendVerificationResponse).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailRequest).toBeDefined();
    expect(document.components?.schemas?.VerifyEmailResponse).toBeDefined();
    expect(document.components?.schemas?.UserSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.UserDataExportResponse).toBeDefined();
    expect(
      document.components?.schemas?.UserDataExportResponse?.properties?.videoRatings,
    ).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        required: ['videoId', 'value', 'createdAt', 'updatedAt'],
      },
    });
    expect(document.components?.schemas?.LogoutAllSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutOtherSessionsResponse).toBeDefined();
    expect(document.components?.schemas?.LogoutSessionResponse).toBeDefined();
    expect(document.paths['/health/live']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/health/ready']?.get?.responses?.[200]).toBeDefined();
    expect(document.paths['/health/ready']?.get?.responses?.[503]).toBeDefined();
    expect(document.components?.schemas?.LivenessResponse).toBeDefined();
    expect(document.components?.schemas?.ReadinessResponse).toBeDefined();
    expect(document.components?.schemas?.ReadinessUnavailableResponse).toBeDefined();
  });

  test('keeps mounted runtime routes and OpenAPI operations in parity', async () => {
    const app = await createOpenApiTestApp();
    const response = await request(app).get('/openapi.json').expect(200);

    await expect(getRuntimeRouteOperations(app)).resolves.toEqual(
      getOpenApiRouteOperations(response.body as OpenApiDocument),
    );
  });

  test('exposes a unique camel-case operationId for every documented operation', async () => {
    const app = await createOpenApiTestApp();
    const response = await request(app).get('/openapi.json').expect(200);
    const document = response.body as OpenApiDocument;
    const operationIds = getOpenApiOperationIds(document);

    expect(operationIds).toHaveLength(getOpenApiRouteOperations(document).length);
    expect(operationIds.every((operationId) => typeof operationId === 'string')).toBe(true);
    expect(
      operationIds.every((operationId) => /^[a-z][A-Za-z0-9]*$/.test(String(operationId))),
    ).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  test('does not leak route docs between generated documents', () => {
    const isolatedRouteDocs = [
      {
        method: 'get',
        path: '/isolated',
        operationId: 'getIsolatedResource',
        responses: {
          200: jsonResponse(
            'Isolated response',
            z
              .object({
                ok: z.literal(true).openapi({ example: true }),
              })
              .openapi('IsolatedOpenApiResponse'),
          ),
        },
      },
    ] satisfies RouteDoc[];

    const documentWithRoute = generateOpenApi({ routeDocs: isolatedRouteDocs });
    const documentWithoutRoute = generateOpenApi({ routeDocs: [] });

    expect(documentWithRoute.paths['/isolated']).toBeDefined();
    expect(documentWithRoute.components?.schemas?.IsolatedOpenApiResponse).toBeDefined();
    expect(documentWithoutRoute.paths['/isolated']).toBeUndefined();
    expect(documentWithoutRoute.components?.schemas?.IsolatedOpenApiResponse).toBeUndefined();
  });
});
