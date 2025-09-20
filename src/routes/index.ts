import { Router } from 'express';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    message: 'fpbackend',
    version: '1.0.0',
    docs: '/docs',
  });
});

registerRoute({
  method: 'GET',
  path: '/',
  summary: 'API root: overview and endpoints',
  responses: {
    '200': '{ "message": "fpbackend", "version": "x.x.x", "docs": "/docs"}',
  },
});

export default router;
