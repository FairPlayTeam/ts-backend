const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StorageBucketName = 'videos' | 'users';

export type UserStorageObjectTarget = {
  bucket: 'users';
  kind: 'user-avatar' | 'user-banner';
  userId: string;
  objectName: string;
};

export type VideoStorageObjectTarget = {
  bucket: 'videos';
  kind: 'video-file' | 'video-thumbnail';
  userId: string;
  videoId: string;
  objectName: string;
};

export type StorageObjectTarget =
  | UserStorageObjectTarget
  | VideoStorageObjectTarget;

export const normalizeStorageObjectName = (
  rawObjectName: string | null | undefined,
): string | null => {
  const normalized = rawObjectName?.trim().replace(/^\/+/, '');
  return normalized && normalized.length > 0 ? normalized : null;
};

const hasUnsafeStorageSegments = (objectName: string): boolean =>
  objectName.split('/').some(
    (segment) =>
      segment.length === 0 || segment === '.' || segment === '..',
  );

const isUuidLike = (value: string): boolean => UUID_PATTERN.test(value);

export const parseStorageObjectTarget = (
  bucket: StorageBucketName,
  objectName: string,
): StorageObjectTarget | null => {
  if (hasUnsafeStorageSegments(objectName)) {
    return null;
  }

  const segments = objectName.split('/');

  if (bucket === 'users') {
    const [userId, scope, filename] = segments;

    if (
      segments.length !== 3 ||
      !isUuidLike(userId) ||
      scope !== 'profile' ||
      !filename
    ) {
      return null;
    }

    if (filename.startsWith('avatar.')) {
      return {
        bucket,
        kind: 'user-avatar',
        userId,
        objectName,
      };
    }

    if (filename.startsWith('banner.')) {
      return {
        bucket,
        kind: 'user-banner',
        userId,
        objectName,
      };
    }

    return null;
  }

  if (segments[0] === 'thumbnails') {
    const [, userId, videoId, filename] = segments;

    if (
      segments.length !== 4 ||
      !isUuidLike(userId) ||
      !isUuidLike(videoId) ||
      !filename
    ) {
      return null;
    }

    return {
      bucket,
      kind: 'video-thumbnail',
      userId,
      videoId,
      objectName,
    };
  }

  const [userId, videoId, ...rest] = segments;

  if (
    segments.length < 3 ||
    !isUuidLike(userId) ||
    !isUuidLike(videoId) ||
    rest.length === 0
  ) {
    return null;
  }

  return {
    bucket,
    kind: 'video-file',
    userId,
    videoId,
    objectName,
  };
};
