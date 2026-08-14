import { Router } from 'express';
import type { RouteDoc } from '../docs/registry.js';
import { jsonResponse } from '../docs/openapi.helpers.js';
import { z } from '../docs/zod.js';

type ReadinessChecks = {
  database(): Promise<void>;
  redis?(): Promise<void>;
  objectStorage?(): Promise<void>;
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
      redis: z.literal('ok').optional().openapi({ example: 'ok' }),
      objectStorage: z.literal('ok').optional().openapi({ example: 'ok' }),
    }),
  })
  .openapi('ReadinessResponse');

const readinessUnavailableSchema = z
  .object({
    status: z.literal('error').openapi({ example: 'error' }),
    services: z.object({
      database: serviceStatusSchema.openapi({ example: 'ok' }),
      redis: serviceStatusSchema.optional().openapi({ example: 'error' }),
      objectStorage: serviceStatusSchema.optional().openapi({ example: 'error' }),
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
      body: { status: 'error', services: { database: 'error' } },
    } as const;
  }

  const [database, redis, objectStorage] = await Promise.allSettled([
    checks.database(),
    checks.redis?.(),
    checks.objectStorage?.(),
  ]);

  const redisStatus = checks.redis ? (redis.status === 'fulfilled' ? 'ok' : 'error') : undefined;
  const objectStorageStatus = checks.objectStorage
    ? objectStorage.status === 'fulfilled'
      ? 'ok'
      : 'error'
    : undefined;

  const allOk =
    database.status === 'fulfilled' &&
    (!checks.redis || redis.status === 'fulfilled') &&
    (!checks.objectStorage || objectStorage.status === 'fulfilled');

  const body = {
    status: allOk ? 'ok' : 'error',
    services: {
      database: database.status === 'fulfilled' ? 'ok' : 'error',
      ...(redisStatus !== undefined && { redis: redisStatus }),
      ...(objectStorageStatus !== undefined && { objectStorage: objectStorageStatus }),
    },
  } as const;

  return { statusCode: allOk ? 200 : 503, body } as const;
};

export const createRouter = ({ readinessChecks = null }: HealthRouterDependencies = {}) => {
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

export const routeDocs = [
  {
    method: 'get',
    path: '/health/live',
    operationId: 'getLiveness',
    summary: 'Liveness probe',
    tags: ['System'],
    responses: {
      200: jsonResponse('Process is alive', livenessSchema),
    },
  },
  {
    method: 'get',
    path: '/health/ready',
    operationId: 'getReadiness',
    summary: 'Readiness probe',
    tags: ['System'],
    responses: {
      200: jsonResponse('Application is ready to serve traffic', readinessSchema),
      503: jsonResponse('Application is not ready to serve traffic', readinessUnavailableSchema),
    },
  },
  {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Health check',
    tags: ['System'],
    responses: {
      200: jsonResponse('API process is running', healthResponseSchema),
    },
  },
] satisfies RouteDoc[];
