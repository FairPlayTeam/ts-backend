import express from 'express';
import type { Request } from 'express';
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
import { ALL_CORS_ORIGINS } from './config/env.parsers.js';
import type { RedisClient } from './lib/redis.js';
import type { AuthService } from './services/auth.types.js';
import helmet from 'helmet';
import {
  PASSWORD_RESET_EMAIL_COOLDOWN_MS,
  RESEND_VERIFICATION_EMAIL_COOLDOWN_MS,
} from './config/constants.js';
import {
  RESEND_VERIFICATION_EMAIL_MESSAGE,
  RESET_PASSWORD_EMAIL_MESSAGE,
} from './services/auth/auth.messages.js';

type CreateAppConfig = Pick<
  Config,
  | 'allowedOrigins'
  | 'baseUrl'
  | 'isProduction'
  | 'jsonBodyLimitBytes'
  | 'profileMediaMaxUploadBytes'
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
  objectStorage?(): Promise<void>;
};

const getRequestId = (rawRequestId: string | string[] | undefined): string => {
  if (Array.isArray(rawRequestId)) {
    return rawRequestId[0] ?? crypto.randomUUID();
  }

  return rawRequestId ?? crypto.randomUUID();
};

const getHeader = (rawHeader: string | string[] | undefined): string | undefined =>
  Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

const getBodyEmail = (req: Request): string | null => {
  const body: unknown = req.body;

  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const email = (body as Record<string, unknown>).email;

  return typeof email === 'string' ? email : null;
};

type SerializedRequestInput = {
  headers?: Record<string, string | string[] | undefined>;
  id?: unknown;
  method?: unknown;
  remoteAddress?: unknown;
  url?: unknown;
};

type SerializedResponseInput = {
  statusCode?: unknown;
};

const serializeStringProperty = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export async function createApp(config: CreateAppConfig, deps: CreateAppDependencies) {
  const app = express();
  const {
    apiLimiter,
    authLimiter,
    registrationIdentifierLimiter,
    loginIdentifierLimiter,
    verifyEmailIdentifierLimiter,
    passwordResetIdentifierLimiter,
    resetPasswordIdentifierLimiter,
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
    getIdentifier: getBodyEmail,
    logger,
  });
  const resendVerificationEmailCooldown = createEmailCooldown({
    redisClient: deps.redisClient ?? null,
    keyPrefix: 'email-cooldown:resend-verification',
    keySecret: config.rateLimitKeySecret,
    ttlMs: RESEND_VERIFICATION_EMAIL_COOLDOWN_MS,
    acceptedResponse: { message: RESEND_VERIFICATION_EMAIL_MESSAGE },
    getIdentifier: getBodyEmail,
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
        req(req: SerializedRequestInput) {
          return {
            id: req.id,
            method: serializeStringProperty(req.method),
            url: serializeStringProperty(req.url),
            remoteAddress: serializeStringProperty(req.remoteAddress),
            userAgent: getHeader(req.headers?.['user-agent']),
          };
        },
        res(res: SerializedResponseInput) {
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

        if (config.allowedOrigins === ALL_CORS_ORIGINS) {
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
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    }),
  );

  app.use(express.json({ limit: config.jsonBodyLimitBytes }));

  const { openApiRouteDocs } = await loadRoutes(
    app,
    new URL('./routes/', import.meta.url),
    {
      authService: deps.authService,
      profileMediaMaxUploadBytes: config.profileMediaMaxUploadBytes,
      authLimiter,
      registrationIdentifierLimiter,
      loginIdentifierLimiter,
      verifyEmailIdentifierLimiter,
      passwordResetEmailCooldown,
      passwordResetIdentifierLimiter,
      resetPasswordIdentifierLimiter,
      readinessChecks: deps.readinessChecks ?? null,
      resendVerificationEmailCooldown,
      resendVerificationIdentifierLimiter,
    },
    apiLimiter,
  );

  const openApiDoc = generateOpenApi({ routeDocs: openApiRouteDocs, serverUrl: config.baseUrl });

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
