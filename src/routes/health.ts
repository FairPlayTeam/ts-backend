import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { minioClient, BUCKETS } from '../lib/minio.js';
import { registerRoute } from '../lib/docs.js';
import {
  aggregateStatus,
  createHealthyServiceCheck,
  createUnavailableServiceCheck,
  type ServiceCheck,
  type ServiceStatus,
} from '../lib/health.js';
import { APP_VERSION } from '../lib/appInfo.js';

const router = Router();

interface HealthResponse {
  status: ServiceStatus;
  timestamp: string;
  uptimeSeconds: number;
  version: string;
  services: {
    database: ServiceCheck;
    storage: ServiceCheck;
  };
}

const checkDatabase = async (): Promise<ServiceCheck> => {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return createHealthyServiceCheck(Date.now() - start);
  } catch (error: unknown) {
    return createUnavailableServiceCheck('database', start, error);
  }
};

const checkStorage = async (): Promise<ServiceCheck> => {
  const start = Date.now();
  try {
    await minioClient.bucketExists(BUCKETS.VIDEOS);
    return createHealthyServiceCheck(Date.now() - start);
  } catch (error: unknown) {
    return createUnavailableServiceCheck('storage', start, error);
  }
};

router.get('/', async (_req, res) => {
  const [database, storage] = await Promise.all([
    checkDatabase(),
    checkStorage(),
  ]);

  const status = aggregateStatus([database, storage]);

  const body: HealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    version: APP_VERSION,
    services: { database, storage },
  };

  res.status(status === 'ok' ? 200 : 503).json(body);
});

registerRoute({
  method: 'GET',
  path: '/health',
  summary: 'Health check',
  description: 'Returns the status of the API and its dependent services (database, object storage). Returns HTTP 503 if any service is down.',
  responses: {
    '200': `{
  "status": "ok",
  "timestamp": "ISO8601",
  "uptimeSeconds": 3600,
  "version": "1.0.0",
  "services": {
    "database": { "status": "ok", "latencyMs": 3 },
    "storage":  { "status": "ok", "latencyMs": 12 }
  }
}`,
    '503': `{
  "status": "down",
  "timestamp": "ISO8601",
  "uptimeSeconds": 3600,
  "version": "1.0.0",
  "services": {
    "database": { "status": "down", "latencyMs": 5001, "error": "Database unavailable" },
    "storage":  { "status": "ok",   "latencyMs": 10 }
  }
}`,
  },
});

export default router;
