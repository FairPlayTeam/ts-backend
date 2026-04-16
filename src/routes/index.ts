import { Router } from 'express';
import { registerRoute } from '../lib/docs.js';
import { APP_API_NAME, APP_VERSION } from '../lib/appInfo.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    name: APP_API_NAME,
    version: APP_VERSION,
    docs: '/docs',
  });
});

registerRoute({
  method: 'GET',
  path: '/',
  summary: 'API root: overview and endpoints',
  responses: {
    '200': '{ "name": "Fairplay API", "version": "x.x.x", "docs": "/docs" }',
  },
});

export default router;
