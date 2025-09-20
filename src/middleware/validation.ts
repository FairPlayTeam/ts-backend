import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    username: z.string().min(3, 'Username must be at least 3 characters').max(20, 'Username must be at most 20 characters').regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    emailOrUsername: z.string().min(1, 'Email or username is required'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const banSchema = z.object({
  body: z.object({
    isBanned: z.boolean(),
    publicReason: z.string().optional().nullable(),
    privateReason: z.string().optional().nullable(),
  }),
});

export const moderationSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject'], { errorMap: () => ({ message: "Action must be 'approve' or 'reject'" }) }),
  }),
});

export const commentSchema = z.object({
  body: z.object({
    content: z.string().min(1, 'Comment content cannot be empty').max(1000, 'Comment must be 1000 characters or less'),
    parentId: z.string().uuid('Invalid parent ID format').optional().nullable(),
  }),
});

export const updateVideoSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(100).optional(),
    description: z.string().max(5000).optional().nullable(),
    visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  }),
});

export const validate = (schema: z.AnyZodObject) => (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    schema.parse({ body: req.body, query: req.query, params: req.params });
    next();
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: error.errors });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

