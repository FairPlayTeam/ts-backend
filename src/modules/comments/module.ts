import { createRouter } from './http/router.js';
import { routeDocs } from './http/openapi.js';

export const commentsHttpModule = {
  name: 'comments',
  mountPath: '/videos',
  createRouter,
  routeDocs,
} as const;
