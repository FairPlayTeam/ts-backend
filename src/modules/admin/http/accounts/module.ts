import { createRouter } from './router.js';
import { routeDocs } from './openapi.js';
import type { RouteDoc } from '../../../../docs/registry.js';

export const adminAccountsHttpModule = {
  name: 'admin',
  mountPath: '/admin',
  createRouter,
  routeDocs: routeDocs satisfies RouteDoc[],
} as const;
