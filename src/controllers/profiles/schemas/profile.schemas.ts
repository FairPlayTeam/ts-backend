import { z } from '../../../docs/zod.js';
import { usernameSchema } from '../../shared/user.schemas.js';

export const publicProfileParamsSchema = z
  .object({
    username: usernameSchema,
  })
  .strict()
  .openapi('PublicProfileParams');

export const getPublicProfileSchema = z.object({
  params: publicProfileParamsSchema,
});

const publicProfileDateTimeSchema = z.string().datetime();

const publicProfileSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  bio: z.string().nullable().openapi({
    example: 'Sharing project updates with my subscribers.',
  }),
  avatarUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/avatar/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  }),
  bannerUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/banner/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  }),
  createdAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

export const publicProfileResponseSchema = z
  .object({
    profile: publicProfileSchema,
  })
  .openapi('PublicProfileResponse');

export type GetPublicProfileParams = z.infer<typeof getPublicProfileSchema>['params'];
