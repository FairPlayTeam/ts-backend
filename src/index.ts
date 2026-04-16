import 'dotenv/config';

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function () {
  return this.toString();
};

import express from 'express';
import cors from 'cors';
import { loadRoutes } from './lib/router.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initializeBuckets } from './lib/minio.js';
import { resumePendingVideoProcessing } from './lib/videoProcessor.js';
import { backfillMissingVideoPublicIds } from './lib/videoIds.js';
import { cleanupExpiredSessions } from './controllers/sessionController.js';
import { cleanupExpiredChunkSessions } from './controllers/uploadController.js';
import {
  parseJsonBodyLimitBytes,
  parseServerPort,
  parseTrustProxy,
  parseUrlEncodedBodyLimitBytes,
  resolveBaseUrl,
} from './lib/serverConfig.js';

const DEFAULT_CLEANUP_INTERVAL_MINUTES = 60;

const parseCleanupIntervalMs = (): number => {
  const rawValue = Number(process.env.CLEANUP_INTERVAL_MINUTES ?? DEFAULT_CLEANUP_INTERVAL_MINUTES);

  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return DEFAULT_CLEANUP_INTERVAL_MINUTES * 60 * 1000;
  }

  return rawValue * 60 * 1000;
};

const cleanupIntervalMs = parseCleanupIntervalMs();

const app = express();
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
const isProduction = process.env.NODE_ENV === 'production';
const port = parseServerPort(process.env.PORT);
const baseUrl = resolveBaseUrl(process.env.BASE_URL, port);
const jsonBodyLimitBytes = parseJsonBodyLimitBytes(
  process.env.JSON_BODY_LIMIT_BYTES,
);
const urlEncodedBodyLimitBytes = parseUrlEncodedBodyLimitBytes(
  process.env.URLENCODED_BODY_LIMIT_BYTES,
);
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

app.set('trust proxy', trustProxy);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }

      if (!isProduction && allowedOrigins.length === 0) {
        cb(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }

      cb(new Error('CORS origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: jsonBodyLimitBytes }));
app.use(
  express.urlencoded({
    extended: true,
    limit: urlEncodedBodyLimitBytes,
    parameterLimit: 100,
  }),
);

await loadRoutes(app, new URL('./routes/', import.meta.url));

app.get('/__up', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use(notFound);
app.use(errorHandler);

let cleanupJobPromise: Promise<void> | null = null;

const runMaintenanceCleanup = async (): Promise<void> => {
  if (cleanupJobPromise) {
    return cleanupJobPromise;
  }

  cleanupJobPromise = (async () => {
    try {
      await cleanupExpiredSessions();
      await cleanupExpiredChunkSessions();
    } catch (error) {
      console.error('Maintenance cleanup run failed:', error);
    } finally {
      cleanupJobPromise = null;
    }
  })();

  return cleanupJobPromise;
};

const scheduleMaintenanceCleanup = (): void => {
  void runMaintenanceCleanup();

  const cleanupTimer = setInterval(() => {
    void runMaintenanceCleanup();
  }, cleanupIntervalMs);

  cleanupTimer.unref?.();
  console.log(`Maintenance cleanup scheduled every ${cleanupIntervalMs / (60 * 1000)} minutes`);
};

const startServer = async () => {
  try {
    await initializeBuckets();
    console.log('MinIO buckets initialized');
    const backfilledPublicIds = await backfillMissingVideoPublicIds();
    if (backfilledPublicIds > 0) {
      console.log(`Backfilled ${backfilledPublicIds} video public IDs`);
    }
    await resumePendingVideoProcessing();
    scheduleMaintenanceCleanup();

    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
      console.log(`Public base URL: ${baseUrl}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
