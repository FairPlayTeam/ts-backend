import { z } from '../../../docs/zod.js';
import { usernameSchema } from '../../../controllers/shared/user.schemas.js';
import { FOLLOW_PROFILE_SUCCESS_MESSAGE, UNFOLLOW_PROFILE_SUCCESS_MESSAGE } from '../constants.js';
import { relativeAssetPathSchema } from '../../../controllers/shared/asset.schemas.js';
import { publicProfileIdentityResponseSchema } from '../../../controllers/shared/profile.schemas.js';
import { publicVideosQuerySchema } from '../../../controllers/videos/schemas/video.schemas.js';
import { FOLLOWING_PROFILES_CURSOR_MAX_LENGTH } from '../followingCursor.js';

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
    cursor: z.string().optional().openapi({
      description: 'Opaque cursor returned by the previous page.',
      maxLength: FOLLOWING_PROFILES_CURSOR_MAX_LENGTH,
    }),
  })
  .strict()
  .openapi('FollowingProfilesQuery');

export const listFollowingProfilesSchema = z.object({
  query: followingProfilesQuerySchema,
});

const publicProfileDateTimeSchema = z.string().datetime();

const publicProfileSchema = publicProfileIdentityResponseSchema.extend({
  bio: z.string().nullable().openapi({
    example: 'Sharing project updates with my subscribers.',
  }),
  bannerUrl: relativeAssetPathSchema.nullable().openapi({
    example: '/profiles/fairplay_creator/banner',
  }),
  followerCount: z.number().int().nonnegative().openapi({ example: 128 }),
  followingCount: z.number().int().nonnegative().openapi({ example: 42 }),
  isFollowing: z.boolean().openapi({ example: true }),
  createdAt: publicProfileDateTimeSchema.openapi({ example: '2026-01-01T00:00:00.000Z' }),
});

const followingProfileSchema = publicProfileIdentityResponseSchema.extend({
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
    nextCursor: z.string().max(FOLLOWING_PROFILES_CURSOR_MAX_LENGTH).nullable().openapi({
      description: 'Opaque cursor to pass as the cursor query parameter for the next page.',
    }),
  })
  .openapi('FollowingProfilesResponse');

export type GetPublicProfileParams = z.infer<typeof getPublicProfileSchema>['params'];
export type ListPublicProfileVideosParams = z.infer<typeof listPublicProfileVideosSchema>['params'];
export type ListPublicProfileVideosQuery = z.infer<typeof listPublicProfileVideosSchema>['query'];
export type GetProfileMediaParams = z.infer<typeof getProfileMediaSchema>['params'];
export type FollowPublicProfileParams = z.infer<typeof followPublicProfileSchema>['params'];
export type UnfollowPublicProfileParams = z.infer<typeof unfollowPublicProfileSchema>['params'];
export type ListFollowingProfilesQuery = z.infer<typeof listFollowingProfilesSchema>['query'];
