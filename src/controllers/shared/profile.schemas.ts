import { z } from '../../docs/zod.js';
import { relativeAssetPathSchema } from './asset.schemas.js';

export const publicProfileIdentityResponseSchema = z
  .object({
    username: z.string().openapi({ example: 'fairplay_creator' }),
    displayName: z.string().nullable().openapi({ example: 'FairPlay Creator' }),
    avatarUrl: relativeAssetPathSchema.nullable().openapi({
      example: '/profiles/fairplay_creator/avatar',
    }),
  })
  .openapi('PublicProfileIdentity');
