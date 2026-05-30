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
import { createEmailCooldown } from './middleware/abuseProtection.js';
import type { Config } from './config/env.js';
import type { RedisClient } from './lib/redis.js';
import type { AuthService } from './services/auth.types.js';
import helmet from 'helmet';
import {
  PASSWORD_RESET_EMAIL_COOLDOWN_MS,
  RESEND_VERIFICATION_EMAIL_COOLDOWN_MS,
} from './config/constants.js';
import {
  RESEND_VERIFICATION_SUCCESS_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
} from './services/auth/auth.messages.js';

type CreateAppConfig = Pick<
  Config,
  | 'allowedOrigins'
  | 'baseUrl'
  | 'isProduction'
  | 'jsonBodyLimitBytes'
  | 'rateLimitKeySecret'
  | 'trustProxy'
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
  const {
    apiLimiter,
    authLimiter,
    loginIdentifierLimiter,
    passwordResetIdentifierLimiter,
    resendVerificationIdentifierLimiter,
  } = createLimiters({
    redisClient: deps.redisClient ?? null,
    rateLimitKeySecret: config.rateLimitKeySecret,
    logger,
  });
  const passwordResetEmailCooldown = createEmailCooldown({
    redisClient: deps.redisClient ?? null,
    keyPrefix: 'email-cooldown:password-reset',
    keySecret: config.rateLimitKeySecret,
    ttlMs: PASSWORD_RESET_EMAIL_COOLDOWN_MS,
    acceptedResponse: { message: RESET_PASSWORD_EMAIL_MESSAGE },
    getIdentifier: (req) => (typeof req.body?.email === 'string' ? req.body.email : null),
    logger,
  });
  const resendVerificationEmailCooldown = createEmailCooldown({
    redisClient: deps.redisClient ?? null,
    keyPrefix: 'email-cooldown:resend-verification',
    keySecret: config.rateLimitKeySecret,
    ttlMs: RESEND_VERIFICATION_EMAIL_COOLDOWN_MS,
    acceptedResponse: { message: RESEND_VERIFICATION_SUCCESS_MESSAGE },
    getIdentifier: (req) => (typeof req.body?.email === 'string' ? req.body.email : null),
    logger,
  });

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  const secureHeaders = helmet();
  const docsHeaders = helmet({ contentSecurityPolicy: false });

  app.use((req, res, next) => {
    // Swagger UI injects inline styles/scripts, so only /docs runs without CSP.
    const headers =
      req.path === '/docs' || req.path.startsWith('/docs/') ? docsHeaders : secureHeaders;

    return headers(req, res, next);
  });

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
      loginIdentifierLimiter,
      passwordResetEmailCooldown,
      passwordResetIdentifierLimiter,
      readinessChecks: deps.readinessChecks ?? null,
      resendVerificationEmailCooldown,
      resendVerificationIdentifierLimiter,
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
