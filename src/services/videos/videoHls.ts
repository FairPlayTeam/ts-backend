import type { VideoRenditionQuality } from '@prisma/client';
import { generateToken } from '../../lib/crypto.js';
import {
  VIDEO_ARTIFACT_TOKEN_PATTERN,
  VIDEO_HLS_SEGMENT_NAME_PATTERN,
  type VideoObjectKeyQuality,
} from './videoObjectKeys.js';

export const VIDEO_HLS_PLAYLIST_MAX_BYTES = 512 * 1024;
export const VIDEO_HLS_MASTER_CACHE_CONTROL = 'no-cache';
export const VIDEO_HLS_RENDITION_CACHE_CONTROL = 'no-cache';
export const VIDEO_HLS_SEGMENT_REDIRECT_CACHE_CONTROL = 'no-store';
export const VIDEO_THUMBNAIL_REDIRECT_CACHE_CONTROL = 'no-store';
export const VIDEO_HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const VIDEO_HLS_QUALITY_PATTERN = /^(?:240p|480p|720p|1080p)$/u;
export const VIDEO_HLS_GENERATION_TOKEN_PATTERN = VIDEO_ARTIFACT_TOKEN_PATTERN;
const MASTER_RENDITION_URI_PATTERN = /^(240p|480p|720p|1080p)\/index\.m3u8$/u;
const RENDITION_SEGMENT_URI_PATTERN = /^segments\/([^/]+)$/u;

export const parseVideoHlsQuality = (value: string): VideoObjectKeyQuality | null =>
  VIDEO_HLS_QUALITY_PATTERN.test(value) ? (value as VideoObjectKeyQuality) : null;

export const parseVideoHlsSegmentName = (value: string): string | null =>
  VIDEO_HLS_SEGMENT_NAME_PATTERN.test(value) ? value : null;

export const createVideoHlsGenerationToken = (): string => generateToken();

export const isVideoHlsGenerationToken = (value: string): boolean =>
  VIDEO_HLS_GENERATION_TOKEN_PATTERN.test(value);

export const toVideoObjectKeyQuality = (quality: VideoRenditionQuality): VideoObjectKeyQuality => {
  switch (quality) {
    case 'p240':
      return '240p';
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
    case '240p':
      return 'p240';
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
  generationToken,
  publicId,
}: {
  generationToken: string;
  publicId: string;
}): string => `/videos/${encodeURIComponent(publicId)}/hls/${encodeURIComponent(generationToken)}`;

export const rewriteVideoHlsMasterPlaylist = (
  playlist: string,
  {
    generationToken,
    publicId,
    qualities,
  }: {
    generationToken: string;
    publicId: string;
    qualities: readonly VideoObjectKeyQuality[];
  },
): string => {
  const persistedQualities = new Set(qualities);
  const generationPath = publicHlsGenerationPath({ generationToken, publicId });

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
    generationToken,
    publicId,
    quality,
  }: {
    generationToken: string;
    publicId: string;
    quality: VideoObjectKeyQuality;
  },
): string => {
  const renditionPath = `${publicHlsGenerationPath({ generationToken, publicId })}/${quality}`;

  return replacePlaylistUriLines(playlist, (uri) => {
    const match = RENDITION_SEGMENT_URI_PATTERN.exec(uri);
    const segmentName = match?.[1] ? parseVideoHlsSegmentName(match[1]) : null;

    if (!segmentName) {
      throw new Error('HLS rendition playlist references an invalid segment');
    }

    return `${renditionPath}/segments/${segmentName}`;
  });
};
