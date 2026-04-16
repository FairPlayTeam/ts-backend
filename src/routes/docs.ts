import { Router } from 'express';
import { getDocs, registerRoute } from '../lib/docs.js';
import { APP_API_NAME, APP_VERSION } from '../lib/appInfo.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    name: APP_API_NAME,
    version: APP_VERSION,
    routes: getDocs(),
  });
});

registerRoute({
  method: 'GET',
  path: '/docs',
  summary: 'List API documentation',
  responses: {
    '200': '{ "name": "Fairplay API", "version": "x.x.x", "routes": [ ... ] }',
  },
});

export default router;
