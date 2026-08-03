import type { ObjectStorage } from '../../lib/objectStorage.js';

export type StoredAssetReference = {
  bucket: string;
  objectKey: string;
};

export const profileAvatarPath = (username: string): string =>
  `/profiles/${encodeURIComponent(username)}/avatar`;

export const profileBannerPath = (username: string): string =>
  `/profiles/${encodeURIComponent(username)}/banner`;

export const videoThumbnailPath = (publicId: string): string =>
  `/videos/${encodeURIComponent(publicId)}/thumbnail`;

export const resolveBestEffortLink = (reference: unknown, path: string): string | null =>
  reference === null || reference === undefined ? null : path;

export const readForProxy = (
  objectStorage: Pick<ObjectStorage, 'readObject'>,
  reference: StoredAssetReference,
  maxBytes: number,
): Promise<Buffer | null> =>
  objectStorage.readObject({
    bucket: reference.bucket,
    objectKey: reference.objectKey,
    maxBytes,
  });

export const resolveSignedRedirect = async (
  objectStorage: Pick<ObjectStorage, 'getSignedUrl' | 'headObject'>,
  reference: StoredAssetReference,
): Promise<string | null> => {
  const storedObject = await objectStorage.headObject(reference);

  return storedObject ? objectStorage.getSignedUrl(reference.objectKey, reference.bucket) : null;
};
