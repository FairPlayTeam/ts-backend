import { createRouter } from './http/router.js';
import { routeDocs } from './http/openapi.js';

export const videoUploadsHttpModule = {
  name: 'videoUploads',
  mountPath: '/videos',
  createRouter,
  routeDocs,
} as const;
