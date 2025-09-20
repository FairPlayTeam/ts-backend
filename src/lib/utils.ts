export const isUUID = (str: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
};

/**
 * Create a Prisma where clause that searches by username or ID
 * If the input looks like a UUID, search both username and ID
 * Otherwise, only search by username to avoid UUID validation errors
 * @param identifier - Username or UUID to search for
 * @returns Prisma where clause
 */
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

  return `${baseUrl}/assets/users/${userId}/${assetType}/${filename}`;
};
