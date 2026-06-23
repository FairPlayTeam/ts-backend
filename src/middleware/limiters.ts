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
  REGISTRATION_IDENTIFIER_RATE_LIMIT_MAX,
  REGISTRATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
  RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MAX,
  RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
  VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_MAX,
  VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
} from '../config/constants.js';
import { hashRateLimitIdentifier } from './abuseProtection.js';

export const AUTH_RATE_LIMIT_MESSAGE = 'Too many auth attempts, please try again after 10 minutes.';
const API_RATE_LIMIT_MESSAGE = 'Too many requests, please try again after 15 minutes.';
export const REGISTRATION_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many registration attempts for this email, please try again later.';
export const LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many login attempts for this identifier, please try again after 10 minutes.';
export const VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many email verification attempts for this email, please try again after 10 minutes.';
const PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many password reset requests for this email, please try again later.';
const RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MESSAGE =
  'Too many verification email requests for this email, please try again later.';

export const authRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', AUTH_RATE_LIMIT_MESSAGE));
};

const apiRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', API_RATE_LIMIT_MESSAGE));
};

const makeStore = (prefix: string, redis: RedisClient | null) => {
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
};

const getBodyString = (req: Request, key: string): string | null => {
  const rawBody: unknown = req.body;
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : {};
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

type IdentifierLimiterOptions = {
  bodyKey: string;
  keyPrefix: string;
  keySecret: string;
  limit: number;
  message: string;
  store: ReturnType<typeof makeStore>;
  windowMs: number;
};

const createIdentifierLimiter = ({
  bodyKey,
  keyPrefix,
  keySecret,
  limit,
  message,
  store,
  windowMs,
}: IdentifierLimiterOptions): RequestHandler =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    passOnStoreError: false,
    keyGenerator: createIdentifierKeyGenerator(keyPrefix, keySecret, bodyKey),
    ...(store ? { store } : {}),
    handler: createRateLimitHandler(message),
  });

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
  const registrationIdentifierStore = makeStore('rl:auth:register-id:', deps.redisClient);
  const loginIdentifierStore = makeStore('rl:auth:login-id:', deps.redisClient);
  const verifyEmailIdentifierStore = makeStore('rl:auth:verify-email-id:', deps.redisClient);
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
    registrationIdentifierLimiter: createIdentifierLimiter({
      windowMs: REGISTRATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: REGISTRATION_IDENTIFIER_RATE_LIMIT_MAX,
      keyPrefix: 'register',
      keySecret: deps.rateLimitKeySecret,
      bodyKey: 'email',
      store: registrationIdentifierStore,
      message: REGISTRATION_IDENTIFIER_RATE_LIMIT_MESSAGE,
    }),
    loginIdentifierLimiter: createIdentifierLimiter({
      windowMs: LOGIN_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: LOGIN_IDENTIFIER_RATE_LIMIT_MAX,
      keyPrefix: 'login',
      keySecret: deps.rateLimitKeySecret,
      bodyKey: 'emailOrUsername',
      store: loginIdentifierStore,
      message: LOGIN_IDENTIFIER_RATE_LIMIT_MESSAGE,
    }),
    verifyEmailIdentifierLimiter: createIdentifierLimiter({
      windowMs: VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_MAX,
      keyPrefix: 'verify-email',
      keySecret: deps.rateLimitKeySecret,
      bodyKey: 'email',
      store: verifyEmailIdentifierStore,
      message: VERIFY_EMAIL_IDENTIFIER_RATE_LIMIT_MESSAGE,
    }),
    passwordResetIdentifierLimiter: createIdentifierLimiter({
      windowMs: PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MAX,
      keyPrefix: 'password-reset',
      keySecret: deps.rateLimitKeySecret,
      bodyKey: 'email',
      store: passwordResetIdentifierStore,
      message: PASSWORD_RESET_IDENTIFIER_RATE_LIMIT_MESSAGE,
    }),
    resendVerificationIdentifierLimiter: createIdentifierLimiter({
      windowMs: RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_WINDOW_MS,
      limit: RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MAX,
      keyPrefix: 'resend-verification',
      keySecret: deps.rateLimitKeySecret,
      bodyKey: 'email',
      store: resendVerificationIdentifierStore,
      message: RESEND_VERIFICATION_IDENTIFIER_RATE_LIMIT_MESSAGE,
    }),
  };
}
