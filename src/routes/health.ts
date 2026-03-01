import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { minioClient, BUCKETS } from '../lib/minio.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

type ServiceStatus = 'ok' | 'degraded' | 'down';

interface ServiceCheck {
  status: ServiceStatus;
  latencyMs: number;
  error?: string;
}

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
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'down', latencyMs: Date.now() - start, error: err?.message ?? 'Unknown error' };
  }
};

const checkStorage = async (): Promise<ServiceCheck> => {
  const start = Date.now();
  try {
    await minioClient.bucketExists(BUCKETS.VIDEOS);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'down', latencyMs: Date.now() - start, error: err?.message ?? 'Unknown error' };
  }
};

const aggregateStatus = (checks: ServiceCheck[]): ServiceStatus => {
  if (checks.every((c) => c.status === 'ok')) return 'ok';
  if (checks.some((c) => c.status === 'down')) return 'down';
  return 'degraded';
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
    version: process.env.npm_package_version ?? 'unknown',
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
    "database": { "status": "down", "latencyMs": 5001, "error": "Connection refused" },
    "storage":  { "status": "ok",   "latencyMs": 10 }
  }
}`,
  },
});

export default router;
