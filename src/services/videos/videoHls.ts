import type { VideoRenditionQuality } from '@prisma/client';
import { VIDEO_HLS_SEGMENT_NAME_PATTERN, type VideoObjectKeyQuality } from './videoObjectKeys.js';

export const VIDEO_HLS_PLAYLIST_MAX_BYTES = 512 * 1024;
export const VIDEO_HLS_MASTER_CACHE_CONTROL = 'no-cache';
export const VIDEO_HLS_RENDITION_CACHE_CONTROL = 'no-cache';
export const VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL = 'no-store';
export const VIDEO_THUMBNAIL_REDIRECT_CACHE_CONTROL = 'no-store';
export const VIDEO_HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const VIDEO_HLS_QUALITY_PATTERN = /^(?:480p|720p|1080p)$/u;
const VIDEO_HLS_GENERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MASTER_RENDITION_URI_PATTERN = /^(480p|720p|1080p)\/index\.m3u8$/u;
const RENDITION_SEGMENT_URI_PATTERN = /^segments\/([^/]+)$/u;

export const parseVideoHlsQuality = (value: string): VideoObjectKeyQuality | null =>
  VIDEO_HLS_QUALITY_PATTERN.test(value) ? (value as VideoObjectKeyQuality) : null;

export const parseVideoHlsSegmentName = (value: string): string | null =>
  VIDEO_HLS_SEGMENT_NAME_PATTERN.test(value) ? value : null;

export const isVideoHlsGenerationId = (value: string): boolean =>
  VIDEO_HLS_GENERATION_ID_PATTERN.test(value);

export const toVideoObjectKeyQuality = (quality: VideoRenditionQuality): VideoObjectKeyQuality => {
  switch (quality) {
    case 'p480':
      return '480p';
    case 'p720':
      return '720p';
    case 'p1080':
      return '1080p';
  }
};

export const toVideoRenditionQuality = (quality: VideoObjectKeyQuality): VideoRenditionQuality => {
  switch (quality) {
    case '480p':
      return 'p480';
    case '720p':
      return 'p720';
    case '1080p':
      return 'p1080';
  }
};

const replacePlaylistUriLines = (playlist: string, replaceUri: (uri: string) => string): string => {
  const parts = playlist.split(/(\r\n|\n|\r)/u);

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];

    if (line === undefined || line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    parts[index] = replaceUri(line);
  }

  return parts.join('');
};

const publicHlsGenerationPath = ({
  generationId,
  publicId,
}: {
  generationId: string;
  publicId: string;
}): string => `/videos/${encodeURIComponent(publicId)}/hls/${encodeURIComponent(generationId)}`;

export const rewriteVideoHlsMasterPlaylist = (
  playlist: string,
  {
    generationId,
    publicId,
    qualities,
  }: {
    generationId: string;
    publicId: string;
    qualities: readonly VideoObjectKeyQuality[];
  },
): string => {
  const persistedQualities = new Set(qualities);
  const generationPath = publicHlsGenerationPath({ generationId, publicId });

  return replacePlaylistUriLines(playlist, (uri) => {
    const match = MASTER_RENDITION_URI_PATTERN.exec(uri);
    const quality = match?.[1] as VideoObjectKeyQuality | undefined;

    if (!quality || !persistedQualities.has(quality)) {
      throw new Error('HLS master playlist references an unknown rendition');
    }

    return `${generationPath}/${quality}/index.m3u8`;
  });
};

export const rewriteVideoHlsRenditionPlaylist = (
  playlist: string,
  {
    generationId,
    publicId,
    quality,
  }: {
    generationId: string;
    publicId: string;
    quality: VideoObjectKeyQuality;
  },
): string => {
  const renditionPath = `${publicHlsGenerationPath({ generationId, publicId })}/${quality}`;

  return replacePlaylistUriLines(playlist, (uri) => {
    const match = RENDITION_SEGMENT_URI_PATTERN.exec(uri);
    const segmentName = match?.[1] ? parseVideoHlsSegmentName(match[1]) : null;

    if (!segmentName) {
      throw new Error('HLS rendition playlist references an invalid segment');
    }

    return `${renditionPath}/segments/${segmentName}`;
  });
};
