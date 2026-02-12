export const isUUID = (str: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
};

export const createUserSearchWhere = (identifier: string) => {
  return isUUID(identifier)
    ? { OR: [{ username: identifier }, { id: identifier }] }
    : { username: identifier };
};

export const getProxiedAssetUrl = (
  userId: string,
  assetPath: string | null,
  assetType: 'avatar' | 'banner',
): string | null => {
  if (!assetPath) return null;

  const filename = assetPath.split('/').pop();
  if (!filename) return null;

  const baseUrl = process.env.BASE_URL || 'http://localhost:2353';

  return `${baseUrl}/users/${userId}/profile/${filename}`;
};

export const getProxiedThumbnailUrl = (
  userId: string,
  videoId: string,
  thumbnailPath: string | null,
): string | null => {
  if (!thumbnailPath) return null;

  const filename = thumbnailPath.split('/').pop();
  if (!filename) return null;

  const baseUrl = process.env.BASE_URL || 'http://localhost:2353';

  return `${baseUrl}/videos/thumbnails/${userId}/${videoId}/${filename}`;
};
