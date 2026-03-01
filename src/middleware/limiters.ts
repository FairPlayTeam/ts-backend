import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

const userAwareKey = (req: Request): string => {
    const userId = (req as any).user?.id
    return userId ? `user_${userId}` : (req.ip ?? 'unknown')
};

export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1200,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again after 15 minutes.' },
});

export const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        error: 'Too many login attempts, please try again after 10 minutes.',
    },
});

export const adminLimiter = rateLimit({
    windowMs: 20 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: userAwareKey,
    message: {
        error: 'Too many requests to admin resources, please try again after 20 minutes.',
    },
});

// 6 uploads per hour maximum
export const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 6,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: userAwareKey,
    message: {
        error: 'Upload limit reached, please try again after 1 hour.',
    },
});