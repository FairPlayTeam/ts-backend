import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';

import loadRoutes from './routing/loadRoutes.js';
import { generateOpenApi } from './docs/openapi.js';
import { HttpError } from './errors/http.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import type { Config } from './config/env.js';

type CreateAppConfig = Pick<
  Config,
  'allowedOrigins' | 'baseUrl' | 'isProduction' | 'jsonBodyLimitBytes' | 'trustProxy'
>;

export async function createApp(config: CreateAppConfig) {
  const app = express();

  app.set('trust proxy', config.trustProxy);

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
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.use(express.json({ limit: config.jsonBodyLimitBytes }));

  await loadRoutes(app, new URL('./routes/', import.meta.url));

  const openApiDoc = generateOpenApi({ serverUrl: config.baseUrl });

  app.get('/openapi.json', (_req, res) => {
    res.json(openApiDoc);
  });

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
