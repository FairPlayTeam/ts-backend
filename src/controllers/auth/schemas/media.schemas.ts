import { z } from '../../../docs/zod.js';
import {
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
} from '../../../services/auth/auth.messages.js';
import { responseMessageSchema } from './shared.schemas.js';
import { relativeAssetPathSchema } from '../../shared/asset.schemas.js';

const createUserMediaUploadBodySchema = (fieldName: 'avatar' | 'banner', componentName: string) =>
  z
    .object({
      [fieldName]: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'JPEG, PNG, or WebP image file.',
      }),
    })
    .openapi(componentName);

export const uploadAvatarBodySchema = createUserMediaUploadBodySchema(
  'avatar',
  'UploadAvatarRequest',
);

export const uploadBannerBodySchema = createUserMediaUploadBodySchema(
  'banner',
  'UploadBannerRequest',
);

type CreateUserMediaAssetResponseSchemaInput = {
  urlExample: string;
  widthExample: number;
  heightExample: number;
};

const createUserMediaAssetResponseSchema = ({
  urlExample,
  widthExample,
  heightExample,
}: CreateUserMediaAssetResponseSchemaInput) =>
  z.object({
    url: relativeAssetPathSchema.openapi({
      example: urlExample,
    }),
    mimeType: z.literal('image/webp').openapi({ example: 'image/webp' }),
    sizeBytes: z.number().int().positive().openapi({ example: 18342 }),
    width: z.number().int().positive().openapi({ example: widthExample }),
    height: z.number().int().positive().openapi({ example: heightExample }),
    updatedAt: z.string().datetime().openapi({ example: '2026-01-01T00:00:00.000Z' }),
  });

const avatarAssetResponseSchema = createUserMediaAssetResponseSchema({
  urlExample: '/profiles/fairplay_creator/avatar',
  widthExample: 512,
  heightExample: 512,
});

const bannerAssetResponseSchema = createUserMediaAssetResponseSchema({
  urlExample: '/profiles/fairplay_creator/banner',
  widthExample: 1500,
  heightExample: 500,
});

export const uploadAvatarResponseSchema = z
  .object({
    message: responseMessageSchema(UPLOAD_AVATAR_SUCCESS_MESSAGE),
    avatar: avatarAssetResponseSchema,
  })
  .openapi('UploadAvatarResponse');

export const deleteAvatarResponseSchema = z
  .object({
    message: responseMessageSchema(DELETE_AVATAR_SUCCESS_MESSAGE),
    avatar: z.null().openapi({ example: null }),
  })
  .openapi('DeleteAvatarResponse');

export const uploadBannerResponseSchema = z
  .object({
    message: responseMessageSchema(UPLOAD_BANNER_SUCCESS_MESSAGE),
    banner: bannerAssetResponseSchema,
  })
  .openapi('UploadBannerResponse');

export const deleteBannerResponseSchema = z
  .object({
    message: responseMessageSchema(DELETE_BANNER_SUCCESS_MESSAGE),
    banner: z.null().openapi({ example: null }),
  })
  .openapi('DeleteBannerResponse');
