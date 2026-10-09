import { createRouter as createAdminRouter, routeDocs as adminRouteDocs } from './admin.js';
import { createRouter as createAuthRouter, routeDocs as authRouteDocs } from './auth.js';
import { createRouter as createHealthRouter, routeDocs as healthRouteDocs } from './health.js';
import rootRouter, { routeDocs as rootRouteDocs } from './index.js';
import {
  createRouter as createModerationRouter,
  routeDocs as moderationRouteDocs,
} from './moderation.js';
import {
  createRouter as createProfilesRouter,
  routeDocs as profilesRouteDocs,
} from './profiles.js';
import { createRouter as createVideosRouter, routeDocs as videosRouteDocs } from './videos.js';
import type { RouteDoc } from '../docs/registry.js';

export const httpRouteModules = [
  {
    name: 'admin',
    mountPath: '/admin',
    createRouter: createAdminRouter,
    routeDocs: adminRouteDocs,
  },
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
  {
    name: 'moderation',
    mountPath: '/moderation',
    createRouter: createModerationRouter,
    routeDocs: moderationRouteDocs,
  },
  {
    name: 'profiles',
    mountPath: '/profiles',
    createRouter: createProfilesRouter,
    routeDocs: profilesRouteDocs,
  },
  {
    name: 'videos',
    mountPath: '/videos',
    createRouter: createVideosRouter,
    routeDocs: videosRouteDocs,
  },
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
