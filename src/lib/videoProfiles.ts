export interface VideoQuality {
  name: string;
  height: number;
  bitrate: string;
  crf: number;
}

export const VIDEO_QUALITIES: VideoQuality[] = [
  { name: '240p', height: 240, bitrate: '400k', crf: 28 },
  { name: '480p', height: 480, bitrate: '800k', crf: 26 },
  { name: '720p', height: 720, bitrate: '2000k', crf: 24 },
  { name: '1080p', height: 1080, bitrate: '4000k', crf: 22 },
];

export const selectQualitiesForSource = (
  sourceHeight: number,
  qualities: readonly VideoQuality[] = VIDEO_QUALITIES,
): VideoQuality[] => {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    return [];
  }

  const matchingQualities = qualities.filter((quality) => quality.height <= sourceHeight);

  if (matchingQualities.length > 0) {
    return [...matchingQualities];
  }

  return qualities.length > 0 ? [{ ...qualities[0] }] : [];
};
