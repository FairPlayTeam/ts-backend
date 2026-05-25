import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import crypto from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import loadRoutes from './routing/loadRoutes.js';
import { generateOpenApi } from './docs/openapi.js';
import { HttpError } from './errors/http.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createLimiters } from './middleware/limiters.js';
import type { Config } from './config/env.js';
import type { RedisClient } from './lib/redis.js';
import type { AuthService } from './services/auth.types.js';
import helmet from 'helmet';

type CreateAppConfig = Pick<
  Config,
  'allowedOrigins' | 'baseUrl' | 'isProduction' | 'jsonBodyLimitBytes' | 'trustProxy'
>;

type CreateAppDependencies = {
  authService: AuthService;
  redisClient?: RedisClient | null;
  readinessChecks?: ReadinessChecks | null;
};

type ReadinessChecks = {
  database(): Promise<void>;
  redis?(): Promise<void>;
};

const getRequestId = (rawRequestId: string | string[] | undefined): string => {
  if (Array.isArray(rawRequestId)) {
    return rawRequestId[0] ?? crypto.randomUUID();
  }

  return rawRequestId ?? crypto.randomUUID();
};

const getHeader = (rawHeader: string | string[] | undefined): string | undefined =>
  Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

export async function createApp(config: CreateAppConfig, deps: CreateAppDependencies) {
  const app = express();
  const { apiLimiter, authLimiter } = createLimiters({
    redisClient: deps.redisClient ?? null,
    logger,
  });

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Swagger UI injects inline styles/scripts, so CSP is disabled here.
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => getRequestId(req.headers['x-request-id']),
      autoLogging: {
        ignore: (req) => req.url === '/favicon.ico',
      },
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
            userAgent: getHeader(req.headers['user-agent']),
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) {
          cb(null, true);
          return;
        }

        if (!config.isProduction && config.allowedOrigins.length === 0) {
          cb(null, true);
          return;
        }

        if (config.allowedOrigins.includes(origin)) {
          cb(null, true);
          return;
        }

        cb(new HttpError(403, 'Forbidden', 'CORS origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    }),
  );

  app.use(express.json({ limit: config.jsonBodyLimitBytes }));

  await loadRoutes(
    app,
    new URL('./routes/', import.meta.url),
    {
      authService: deps.authService,
      authLimiter,
      readinessChecks: deps.readinessChecks ?? null,
    },
    apiLimiter,
  );

  const openApiDoc = generateOpenApi({ serverUrl: config.baseUrl });

  app.get('/openapi.json', apiLimiter, (_req, res) => {
    res.set(
      'Cache-Control',
      config.isProduction ? 'public, max-age=300, stale-while-revalidate=60' : 'no-store',
    );

    res.json(openApiDoc);
  });

  app.use(
    '/docs',
    apiLimiter,
    swaggerUi.serve,
    swaggerUi.setup(openApiDoc, {
      explorer: true,
      swaggerOptions: {
        persistAuthorization: false,
      },
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
