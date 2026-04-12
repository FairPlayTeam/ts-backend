const baseUrl = (process.env.BASE_URL || 'http://localhost:2353').replace(/\/$/, '');

export const isUUID = (str: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
};

export const createUserSearchWhere = (identifier: string) => {
  const normalizedIdentifier = identifier.trim();
  const normalizedUsername = normalizedIdentifier.toLowerCase();

  return isUUID(normalizedIdentifier)
    ? { OR: [{ username: normalizedUsername }, { id: normalizedIdentifier }] }
    : { username: normalizedUsername };
};

export const getProxiedAssetUrl = (
  userId: string,
  assetPath: string | null
): string | null => {
  if (!assetPath) return null;

  const filename = assetPath.split('/').pop();
  if (!filename) return null;

  if (assetPath.includes('/profile/avatar.')) {
    return `${baseUrl}/assets/users/${userId}/avatar/${filename}`;
  }

  if (assetPath.includes('/profile/banner.')) {
    return `${baseUrl}/assets/users/${userId}/banner/${filename}`;
  }

  return null;
};

export const getProxiedThumbnailUrl = (
  userId: string,
  videoId: string,
  thumbnailPath: string | null,
): string | null => {
  if (!thumbnailPath) return null;

  const filename = thumbnailPath.split('/').pop();
  if (!filename) return null;

  return `${baseUrl}/assets/videos/${userId}/${videoId}/thumbnail/${filename}`;
};
