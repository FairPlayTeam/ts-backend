import { routeDocs } from './openapi/index.js';
import { createRouter } from './router.js';

export const authHttpModule = {
  name: 'auth',
  mountPath: '/auth',
  createRouter,
  routeDocs,
} as const;
