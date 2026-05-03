import { Router } from 'express';
import '../docs/zod.js';
import { z } from 'zod';
import { registerRoute } from '../docs/registry.js';

const router = Router();

const healthResponseSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
    uptime: z.number().openapi({ example: 42.5 }),
  })
  .openapi('HealthResponse');

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
  });
});

registerRoute({
  method: 'get',
  path: '/health',
  summary: 'Health check',
  tags: ['System'],
  responses: {
    200: {
      description: 'API process is running',
      content: {
        'application/json': {
          schema: healthResponseSchema,
        },
      },
    },
  },
});

export default router;
