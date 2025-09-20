import 'dotenv/config';

// @ts-ignore
BigInt.prototype.toJSON = function () {
  return this.toString();
};
import express from 'express';
import cors from 'cors';
import { loadRoutes } from './lib/router.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initializeBuckets } from './lib/minio.js';
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const app = express();

app.use(limiter);

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
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
