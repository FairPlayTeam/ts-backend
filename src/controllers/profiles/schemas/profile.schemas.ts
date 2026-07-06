import { z } from '../../../docs/zod.js';
import { usernameSchema } from '../../shared/user.schemas.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../../services/profiles/profiles.messages.js';

export const FOLLOWING_PROFILES_CURSOR_PAIR_MESSAGE =
  'cursorFollowedAt and cursorId must be provided together';

export const publicProfileParamsSchema = z
  .object({
    username: usernameSchema,
  })
  .strict()
  .openapi('PublicProfileParams');

export const getPublicProfileSchema = z.object({
  params: publicProfileParamsSchema,
});

export const followPublicProfileSchema = z.object({
  params: publicProfileParamsSchema,
});

export const unfollowPublicProfileSchema = z.object({
  params: publicProfileParamsSchema,
});

export const followingProfilesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().openapi({ example: 20 }),
    cursorFollowedAt: z.string().datetime().optional().openapi({
      example: '2026-01-01T00:00:00.000Z',
    }),
    cursorId: z
      .string()
      .uuid('Cursor profile id must be a valid UUID')
      .optional()
      .openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  })
  .strict()
  .refine((query) => (query.cursorFollowedAt === undefined) === (query.cursorId === undefined), {
    message: FOLLOWING_PROFILES_CURSOR_PAIR_MESSAGE,
  })
  .openapi('FollowingProfilesQuery');

export const listFollowingProfilesSchema = z.object({
  query: followingProfilesQuerySchema,
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
  followerCount: z.number().int().nonnegative().openapi({ example: 128 }),
  followingCount: z.number().int().nonnegative().openapi({ example: 42 }),
  createdAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const followingProfileSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  avatarUrl: z.string().url().nullable().openapi({
    example:
      'http://localhost:9000/fairplay-user-media/users/9fdf5/avatar/550e8400-e29b-41d4-a716-446655440000.webp?signature=...',
  }),
  followedAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

export const publicProfileResponseSchema = z
  .object({
    profile: publicProfileSchema,
  })
  .openapi('PublicProfileResponse');

export const followPublicProfileResponseSchema = z
  .object({
    message: z.literal(FOLLOW_PROFILE_SUCCESS_MESSAGE).openapi({
      example: FOLLOW_PROFILE_SUCCESS_MESSAGE,
    }),
    profile: publicProfileSchema,
  })
  .openapi('FollowPublicProfileResponse');

export const unfollowPublicProfileResponseSchema = z
  .object({
    message: z.literal(UNFOLLOW_PROFILE_SUCCESS_MESSAGE).openapi({
      example: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
    }),
    profile: publicProfileSchema,
  })
  .openapi('UnfollowPublicProfileResponse');

export const followingProfilesResponseSchema = z
  .object({
    profiles: z.array(followingProfileSchema),
    total: z.number().int().nonnegative().openapi({ example: 42 }),
    nextCursor: z
      .object({
        followedAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
        id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
      })
      .nullable(),
  })
  .openapi('FollowingProfilesResponse');

export type GetPublicProfileParams = z.infer<typeof getPublicProfileSchema>['params'];
export type FollowPublicProfileParams = z.infer<typeof followPublicProfileSchema>['params'];
export type UnfollowPublicProfileParams = z.infer<typeof unfollowPublicProfileSchema>['params'];
export type ListFollowingProfilesQuery = z.infer<typeof listFollowingProfilesSchema>['query'];
