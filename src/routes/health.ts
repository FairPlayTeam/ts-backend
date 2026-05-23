import { Router } from 'express';
import '../docs/zod.js';
import { z } from 'zod';
import { registerRoute } from '../docs/registry.js';
import { jsonResponse } from '../docs/openapi.helpers.js';

type ReadinessChecks = {
  database(): Promise<void>;
  redis(): Promise<void>;
};

type HealthRouterDependencies = {
  readinessChecks?: ReadinessChecks | null;
};

const serviceStatusSchema = z.enum(['ok', 'error']);

const livenessSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
    uptime: z.number().openapi({ example: 42.5 }),
  })
  .openapi('LivenessResponse');

const readinessSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
    services: z.object({
      database: z.literal('ok').openapi({ example: 'ok' }),
      redis: z.literal('ok').openapi({ example: 'ok' }),
    }),
  })
  .openapi('ReadinessResponse');

const readinessUnavailableSchema = z
  .object({
    status: z.literal('error').openapi({ example: 'error' }),
    services: z.object({
      database: serviceStatusSchema.openapi({ example: 'ok' }),
      redis: serviceStatusSchema.openapi({ example: 'error' }),
    }),
  })
  .openapi('ReadinessUnavailableResponse');

const healthResponseSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
    uptime: z.number().openapi({ example: 42.5 }),
  })
  .openapi('HealthResponse');

const createReadinessResponse = async (checks: ReadinessChecks | null) => {
  if (!checks) {
    return {
      statusCode: 503,
      body: {
        status: 'error',
        services: {
          database: 'error',
          redis: 'error',
        },
      },
    } as const;
  }

  const [database, redis] = await Promise.allSettled([checks.database(), checks.redis()]);
  const body = {
    status: database.status === 'fulfilled' && redis.status === 'fulfilled' ? 'ok' : 'error',
    services: {
      database: database.status === 'fulfilled' ? 'ok' : 'error',
      redis: redis.status === 'fulfilled' ? 'ok' : 'error',
    },
  } as const;

  return {
    statusCode: body.status === 'ok' ? 200 : 503,
    body,
  } as const;
};

const createHealthRouter = ({ readinessChecks = null }: HealthRouterDependencies = {}) => {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const result = await createReadinessResponse(readinessChecks);
      res.status(result.statusCode).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  return router;
};

export const createRouter = createHealthRouter;

registerRoute({
  method: 'get',
  path: '/health/live',
  summary: 'Liveness probe',
  tags: ['System'],
  responses: {
    200: jsonResponse('Process is alive', livenessSchema),
  },
});

registerRoute({
  method: 'get',
  path: '/health/ready',
  summary: 'Readiness probe',
  tags: ['System'],
  responses: {
    200: jsonResponse('Application is ready to serve traffic', readinessSchema),
    503: jsonResponse('Application is not ready to serve traffic', readinessUnavailableSchema),
  },
});

registerRoute({
  method: 'get',
  path: '/health',
  summary: 'Health check',
  tags: ['System'],
  responses: {
    200: jsonResponse('API process is running', healthResponseSchema),
  },
});
