import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { HttpError } from '../errors/http.js';
import type { SendCommandFn } from 'rate-limit-redis';
import type { RedisClient } from '../lib/redis.js';
import type { Logger } from 'pino';
import {
  LOGIN_IDENTIFIER_RATE_LIMIT_MAX,
  LOGIN_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
  PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MAX,
  PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
  RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MAX,
  RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
} from '../config/constants.js';
import { hashRateLimitIdentifier } from './abuseProtection.js';

const AUTH_RATE_LIMIT_MESSAGE = 'Too many auth attempts, please try again after 10 minutes.';
const API_RATE_LIMIT_MESSAGE = 'Too many requests, please try again after 15 minutes.';
const LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many login attempts for this identifier, please try again after 10 minutes.';
const PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many password reset requests for this email, please try again later.';
const RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many verification email requests for this email, please try again later.';

export const authRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', AUTH_RATE_LIMIT_MESSAGE));
};

export const apiRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', API_RATE_LIMIT_MESSAGE));
};

const makeStore = (prefix: string, redis: RedisClient | null) =>
  (() => {
    if (!redis) {
      return undefined;
    }

    return new RedisStore({
      sendCommand: ((...args: string[]) => {
        const [command, ...rest] = args;

        if (!command) {
          throw new Error('Redis command is empty');
        }

        return redis.call(command, ...rest);
      }) as SendCommandFn,
      prefix,
    });
  })();

const getBodyString = (req: Request, key: string): string | null => {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const value = (body as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : null;
};

const createIdentifierKeyGenerator =
  (prefix: string, keySecret: string, bodyKey: string) =>
  (req: Request): string => {
    const identifier = getBodyString(req, bodyKey) ?? 'missing-identifier';

    return `${prefix}:${hashRateLimitIdentifier(keySecret, identifier)}`;
  };

const createRateLimitHandler =
  (message: string): RequestHandler =>
  (_req, _res, next) => {
    next(new HttpError(429, 'TooManyRequests', message));
  };

export function createLimiters(deps: {
  redisClient: RedisClient | null;
  rateLimitKeySecret: string;
  logger: Pick<Logger, 'warn'>;
}) {
  if (!deps.redisClient) {
    deps.logger.warn('REDIS_URL is not configured; rate limiting uses in-memory storage.');
  }

  const apiStore = makeStore('rl:api:', deps.redisClient);
  const authStore = makeStore('rl:auth:', deps.redisClient);
  const loginIdentifierStore = makeStore('rl:auth:login-id:', deps.redisClient);
  const passwordResetIdentifierStore = makeStore('rl:auth:password-reset-id:', deps.redisClient);
  const resendVerificationIdentifierStore = makeStore(
    'rl:auth:resend-verification-id:',
    deps.redisClient,
  );

  return {
    apiLimiter: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 1200,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      passOnStoreError: true,
      ...(apiStore ? { store: apiStore } : {}),
      handler: apiRateLimitExceededHandler,
    }),
    authLimiter: rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      passOnStoreError: false,
      ...(authStore ? { store: authStore } : {}),
      handler: authRateLimitExceededHandler,
    }),
    loginIdentifierLimiter: rateLimit({
      windowMs: LOGIN_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: LOGIN_IDENTIFIER_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      passOnStoreError: false,
      keyGenerator: createIdentifierKeyGenerator(
        'login',
        deps.rateLimitKeySecret,
        'emailOrUsername',
      ),
      ...(loginIdentifierStore ? { store: loginIdentifierStore } : {}),
      handler: createRateLimitHandler(LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE),
    }),
    passwordResetIdentifierLimiter: rateLimit({
      windowMs: PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      passOnStoreError: false,
      keyGenerator: createIdentifierKeyGenerator(
        'password-reset',
        deps.rateLimitKeySecret,
        'email',
      ),
      ...(passwordResetIdentifierStore ? { store: passwordResetIdentifierStore } : {}),
      handler: createRateLimitHandler(PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MESSAGE),
    }),
    resendVerificationIdentifierLimiter: rateLimit({
      windowMs: RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      passOnStoreError: false,
      keyGenerator: createIdentifierKeyGenerator(
        'resend-verification',
        deps.rateLimitKeySecret,
        'email',
      ),
      ...(resendVerificationIdentifierStore ? { store: resendVerificationIdentifierStore } : {}),
      handler: createRateLimitHandler(RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MESSAGE),
    }),
  };
}
