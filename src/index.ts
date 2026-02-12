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

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = Number(process.env.PORT ?? 3000);

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

const startServer = async () => {
  try {
    await initializeBuckets();
    console.log('MinIO buckets initialized');

    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
