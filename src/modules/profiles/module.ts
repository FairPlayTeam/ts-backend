import { createRouter } from './http/router.js';
import { routeDocs } from './http/openapi.js';

export const profilesHttpModule = {
  name: 'profiles',
  mountPath: '/profiles',
  createRouter,
  routeDocs,
} as const;
