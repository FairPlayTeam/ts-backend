export const VIDEO_OBJECT_KEY_QUALITIES = ['240p', '480p', '720p', '1080p'] as const;

export type VideoObjectKeyQuality = (typeof VIDEO_OBJECT_KEY_QUALITIES)[number];

const VIDEO_ORIGINAL_FILENAME = 'original.mp4';
const HLS_MASTER_FILENAME = 'master.m3u8';
const HLS_VARIANT_PLAYLIST_FILENAME = 'index.m3u8';
const THUMBNAIL_PREFIX = 'thumbnails';
const VIDEO_OBJECT_KEY_QUALITY_SET: ReadonlySet<string> = new Set(VIDEO_OBJECT_KEY_QUALITIES);

export const isVideoObjectKeyQuality = (quality: string): quality is VideoObjectKeyQuality =>
  VIDEO_OBJECT_KEY_QUALITY_SET.has(quality);

const assertVideoObjectKeyQuality: (quality: string) => asserts quality is VideoObjectKeyQuality = (
  quality,
) => {
  if (!isVideoObjectKeyQuality(quality)) {
    throw new Error('quality must be a supported video object-key quality');
  }
};

const assertObjectKeySegment = (name: string, value: string): void => {
  if (value.trim() === '') {
    throw new Error(`${name} must not be empty`);
  }

  if (/[\\/]/u.test(value)) {
    throw new Error(`${name} must be a single object-key segment`);
  }
};

const videoBasePrefix = (userId: string, videoId: string): string => {
  assertObjectKeySegment('userId', userId);
  assertObjectKeySegment('videoId', videoId);

  return `${userId}/${videoId}`;
};

export const videoOriginalKey = (userId: string, videoId: string): string =>
  `${videoBasePrefix(userId, videoId)}/${VIDEO_ORIGINAL_FILENAME}`;

export const hlsMasterKey = (userId: string, videoId: string): string =>
  `${videoBasePrefix(userId, videoId)}/${HLS_MASTER_FILENAME}`;

export const hlsVariantPlaylistKey = (
  userId: string,
  videoId: string,
  quality: VideoObjectKeyQuality,
): string => {
  assertVideoObjectKeyQuality(quality);

  return `${videoBasePrefix(userId, videoId)}/${quality}/${HLS_VARIANT_PLAYLIST_FILENAME}`;
};

export const hlsSegmentPrefix = (
  userId: string,
  videoId: string,
  quality: VideoObjectKeyQuality,
): string => {
  assertVideoObjectKeyQuality(quality);

  return `${videoBasePrefix(userId, videoId)}/${quality}/`;
};

export const videoThumbnailKey = (userId: string, videoId: string, filename: string): string => {
  assertObjectKeySegment('filename', filename);

  return `${THUMBNAIL_PREFIX}/${videoBasePrefix(userId, videoId)}/${filename}`;
};
