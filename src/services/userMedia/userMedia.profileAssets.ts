import type { Prisma } from '@prisma/client';
import {
  profileAvatarPath,
  profileBannerPath,
  resolveBestEffortLink,
} from '../assets/assetLinks.js';
import type { UserMediaKind } from './userMedia.types.js';

export const profileMediaAssetWhere = {
  kind: {
    in: ['avatar', 'banner'],
  },
} satisfies Prisma.UserMediaAssetWhereInput;

export const profileMediaAssetSelect = {
  id: true,
  kind: true,
} satisfies Prisma.UserMediaAssetSelect;

export const profileAvatarMediaAssetsSelection = {
  where: {
    kind: 'avatar',
  },
  select: {
    id: true,
  },
  take: 1,
} satisfies Prisma.UserMediaAssetFindManyArgs;

export type ProfileMediaAsset = Prisma.UserMediaAssetGetPayload<{
  select: typeof profileMediaAssetSelect;
}>;

const getProfileMediaAsset = (
  mediaAssets: readonly ProfileMediaAsset[],
  kind: UserMediaKind,
): ProfileMediaAsset | undefined => mediaAssets.find((asset) => asset.kind === kind);

export const toProfileMediaUrl = (
  username: string,
  kind: UserMediaKind,
  asset: object | null | undefined,
): string | null =>
  resolveBestEffortLink(
    asset,
    kind === 'avatar' ? profileAvatarPath(username) : profileBannerPath(username),
  );

export const toProfileMediaUrls = (
  username: string,
  mediaAssets: readonly ProfileMediaAsset[],
): { avatarUrl: string | null; bannerUrl: string | null } => ({
  avatarUrl: toProfileMediaUrl(username, 'avatar', getProfileMediaAsset(mediaAssets, 'avatar')),
  bannerUrl: toProfileMediaUrl(username, 'banner', getProfileMediaAsset(mediaAssets, 'banner')),
});
