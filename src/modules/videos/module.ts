import { createRouter } from './http/router.js';
import { routeDocs } from './http/openapi.js';

export const videosHttpModule = {
  name: 'videos',
  mountPath: '/videos',
  createRouter,
  routeDocs,
} as const;
