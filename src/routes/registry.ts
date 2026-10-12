import { createRouter as createAuthRouter, routeDocs as authRouteDocs } from './auth.js';
import { createRouter as createHealthRouter, routeDocs as healthRouteDocs } from './health.js';
import rootRouter, { routeDocs as rootRouteDocs } from './index.js';
import { profilesHttpModule } from '../modules/profiles/index.js';
import { commentsHttpModule } from '../modules/comments/index.js';
import { videoUploadsHttpModule } from '../modules/videoUploads/index.js';
import { videosHttpModule } from '../modules/videos/index.js';
import { adminAccountsHttpModule, videoModerationHttpModule } from '../modules/admin/index.js';
import type { RouteDoc } from '../docs/registry.js';

export const httpRouteModules = [
  adminAccountsHttpModule,
  {
    name: 'auth',
    mountPath: '/auth',
    createRouter: createAuthRouter,
    routeDocs: authRouteDocs,
  },
  {
    name: 'health',
    mountPath: '/health',
    createRouter: createHealthRouter,
    routeDocs: healthRouteDocs,
  },
  videoModerationHttpModule,
  profilesHttpModule,
  commentsHttpModule,
  videoUploadsHttpModule,
  videosHttpModule,
  {
    name: 'root',
    mountPath: '/',
    createRouter: () => rootRouter,
    routeDocs: rootRouteDocs,
  },
] as const;

export const httpRouteDocs: readonly RouteDoc[] = httpRouteModules.flatMap<RouteDoc>(
  ({ routeDocs }): RouteDoc[] => routeDocs,
);
