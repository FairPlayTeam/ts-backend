import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS } from '../lib/uploadConfig.js';

const getClientKey = (req: Request): string =>
    req.ip ?? req.socket.remoteAddress ?? 'unknown';

const userAwareKey = (req: Request): string => {
    const userId = (req as any).user?.id
    return userId ? `user_${userId}` : getClientKey(req)
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

// Limits how many new upload flows a user can start in one hour.
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

export const passwordResetRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
        error: 'Too many password reset requests, please try again after 15 minutes.',
    },
});

export const passwordResetConfirmLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: {
        error: 'Too many password reset attempts, please try again after 15 minutes.',
    },
});

const chunkUploadLimitPerWindow = Math.max(240, MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS * 5);

// Allows chunked uploads to progress while still protecting the API from abuse.
export const chunkUploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: chunkUploadLimitPerWindow,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: userAwareKey,
    message: {
        error: 'Chunk upload request limit reached, please try again after 1 hour.',
    },
});
