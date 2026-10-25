import { isUUID } from './utils.js';
import { VIDEO_QUALITIES } from './videoProfiles.js';

const VALID_HLS_QUALITIES = new Set(
  VIDEO_QUALITIES.map((quality) => quality.name),
);
const HLS_SEGMENT_NAME_PATTERN = /^segment_\d+\.ts$/;

export const hasValidStreamIdentifiers = (
  userId: string,
  videoId: string,
): boolean => isUUID(userId) && isUUID(videoId);

export const isValidHlsQuality = (quality: string): boolean =>
  VALID_HLS_QUALITIES.has(quality);

export const isValidHlsSegmentName = (segment: string): boolean =>
  HLS_SEGMENT_NAME_PATTERN.test(segment);

const appendQueryParam = (
  uri: string,
  key: string,
  value: string,
): string => {
  const [beforeHash, hash = ''] = uri.split('#', 2);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash ? `#${hash}` : ''}`;
};

export const rewritePlaylistWithToken = (
  playlist: string,
  token: string,
): string =>
  playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmedLine = line.trim();

      if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
        return line;
      }

      return appendQueryParam(trimmedLine, 'token', token);
    })
    .join('\n');
