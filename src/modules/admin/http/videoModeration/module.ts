import { createRouter } from './router.js';
import { routeDocs } from './openapi.js';
import type { RouteDoc } from '../../../../docs/registry.js';

export const videoModerationHttpModule = {
  name: 'moderation',
  mountPath: '/moderation',
  createRouter,
  routeDocs: routeDocs satisfies RouteDoc[],
} as const;
