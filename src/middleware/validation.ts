import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

const passwordSchema = z
  .string()
  .min(6, 'Password must be at least 6 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/,
    'Password must contain at least one special character (!@#$...)',
  );

export const registerSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Invalid email format').max(254),
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters')
      .max(20, 'Username must be at most 20 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
    password: passwordSchema,
  }),
});

export const loginSchema = z.object({
  body: z.object({
    emailOrUsername: z.string().trim().min(1, 'Email or username is required').max(254),
    password: z.string().min(1, 'Password is required').max(128),
  }),
});

export const resendVerificationSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Invalid email format').max(254),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().trim().email('Invalid email format').max(254),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().trim().min(1, 'Reset token is required').max(255),
    password: passwordSchema,
  }),
});

export const banSchema = z.object({
  body: z.object({
    isBanned: z.boolean(),
    privateReason: z.string().max(1000).optional().nullable(),
  }),
});

export const moderationSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject'], {
      errorMap: () => ({ message: "Action must be 'approve' or 'reject'" }),
    }),
  }),
});

export const commentSchema = z.object({
  body: z.object({
    content: z
      .string()
      .trim()
      .min(1, 'Comment content cannot be empty')
      .max(500, 'Comment must be 500 characters or less'),
    parentId: z.string().uuid('Invalid parent ID format').optional().nullable(),
  }),
});

export const updateVideoSchema = z
  .object({
    body: z.object({
      title: z.string().trim().min(1).max(100).optional(),
      description: z.string().trim().max(5000).optional().nullable(),
      visibility: z.enum(['public', 'unlisted', 'private']).optional(),
    }),
  })
  .refine(
    ({ body }) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.visibility !== undefined,
    { message: 'At least one field must be provided' },
  );

export const updateProfileSchema = z
  .object({
    body: z.object({
      displayName: z.string().trim().min(1).max(30).optional().nullable(),
      bio: z.string().trim().max(200).optional().nullable(),
    }),
  })
  .refine(
    ({ body }) => body.displayName !== undefined || body.bio !== undefined,
    { message: 'At least one field must be provided' },
  );

export const roleSchema = z.object({
  body: z.object({
    role: z.enum(['user', 'moderator', 'admin']),
  }),
});

const httpUrlSchema = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'URL must start with http:// or https://',
  });

export const upsertCampaignSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1, 'Title is required').max(50),
    description: z
      .string()
      .trim()
      .min(1, 'Description is required')
      .max(200),
    link: httpUrlSchema,
    thumbnailUrl: httpUrlSchema,
  }),
});

const formatZodErrors = (error: ZodError) =>
  error.errors.map(({ path, message }) => ({
    field: path.filter((p) => p !== 'body').join('.') || 'unknown',
    message,
  }));

export const validate =
  (schema: z.ZodTypeAny) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: formatZodErrors(result.error),
      });
    }

    req.body = result.data.body;
    if (result.data.query) req.query = result.data.query;
    if (result.data.params) req.params = result.data.params;

    next();
  };
