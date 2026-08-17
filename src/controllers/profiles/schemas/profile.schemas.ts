import { z } from '../../../docs/zod.js';
import { usernameSchema } from '../../shared/user.schemas.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../../services/profiles/profiles.messages.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';
import { publicVideosQuerySchema } from '../../videos/schemas/video.schemas.js';

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

export const listPublicProfileVideosSchema = z.object({
  params: publicProfileParamsSchema,
  query: publicVideosQuerySchema,
});

export const getProfileMediaSchema = z.object({
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
  avatarUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/avatar',
  }),
  bannerUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/banner',
  }),
  followerCount: z.number().int().nonnegative().openapi({ example: 128 }),
  followingCount: z.number().int().nonnegative().openapi({ example: 42 }),
  isFollowing: z.boolean().openapi({ example: true }),
  createdAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const followingProfileSchema = z.object({
  id: z.string().uuid().openapi({ example: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f' }),
  username: z.string().openapi({ example: 'fairplay_creator' }),
  displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
  avatarUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/avatar',
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
export type ListPublicProfileVideosParams = z.infer<typeof listPublicProfileVideosSchema>['params'];
export type ListPublicProfileVideosQuery = z.infer<typeof listPublicProfileVideosSchema>['query'];
export type GetProfileMediaParams = z.infer<typeof getProfileMediaSchema>['params'];
export type FollowPublicProfileParams = z.infer<typeof followPublicProfileSchema>['params'];
export type UnfollowPublicProfileParams = z.infer<typeof unfollowPublicProfileSchema>['params'];
export type ListFollowingProfilesQuery = z.infer<typeof listFollowingProfilesSchema>['query'];
