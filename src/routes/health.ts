import { Router } from 'express';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

registerRoute({
  method: 'GET',
  path: '/health',
  summary: 'Health check',
  responses: { '200': '{ "status": "ok", "timestamp": "ISO8601", "uptime": 123.45 }' },
});

export default router;
