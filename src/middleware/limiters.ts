import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'TooManyRequests',
    message: 'Too many auth attempts, please try again after 10 minutes.',
  },
});
