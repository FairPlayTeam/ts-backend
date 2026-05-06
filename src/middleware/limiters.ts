import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError } from '../errors/http.js';

const AUTH_RATE_LIMIT_MESSAGE = 'Too many auth attempts, please try again after 10 minutes.';

export const authRateLimitExceededHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(429, 'TooManyRequests', AUTH_RATE_LIMIT_MESSAGE));
};

export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: authRateLimitExceededHandler,
});
