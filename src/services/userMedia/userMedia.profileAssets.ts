import type { Prisma } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { UserMediaKind } from './userMedia.types.js';

export const profileMediaAssetWhere = {
  kind: {
    in: ['avatar', 'banner'],
  },
} satisfies Prisma.UserMediaAssetWhereInput;

export const profileMediaAssetSelect = {
  kind: true,
  objectKey: true,
} satisfies Prisma.UserMediaAssetSelect;

export type ProfileMediaAsset = Prisma.UserMediaAssetGetPayload<{
  select: typeof profileMediaAssetSelect;
}>;

const getProfileMediaAsset = (
  mediaAssets: readonly ProfileMediaAsset[],
  kind: UserMediaKind,
): ProfileMediaAsset | undefined => mediaAssets.find((asset) => asset.kind === kind);

export function toStoredUserMediaAssetUrl(
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>,
  asset: { objectKey: string },
): Promise<string>;
export function toStoredUserMediaAssetUrl(
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>,
  asset: { objectKey: string } | null | undefined,
): Promise<string | null>;
export async function toStoredUserMediaAssetUrl(
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>,
  asset: { objectKey: string } | null | undefined,
): Promise<string | null> {
  return asset ? objectStorage.getSignedUrl(asset.objectKey) : null;
}

export const toProfileMediaUrls = async (
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>,
  mediaAssets: readonly ProfileMediaAsset[],
): Promise<{ avatarUrl: string | null; bannerUrl: string | null }> => {
  const [avatarUrl, bannerUrl] = await Promise.all([
    toStoredUserMediaAssetUrl(objectStorage, getProfileMediaAsset(mediaAssets, 'avatar')),
    toStoredUserMediaAssetUrl(objectStorage, getProfileMediaAsset(mediaAssets, 'banner')),
  ]);

  return {
    avatarUrl,
    bannerUrl,
  };
};
