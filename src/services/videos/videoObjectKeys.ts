type VideoObjectKeyQuality = '480p' | '720p' | '1080p';

export type VideoArtifactProfile = {
  quality: VideoObjectKeyQuality;
  width: number;
  height: number;
  bandwidth: number;
};

export type VideoArtifactManifest = {
  hlsPrefix: string;
  master: {
    objectKey: string;
    relativePath: string;
  };
  thumbnailPrefix: string;
  thumbnail: {
    objectKey: string;
    relativePath: string;
  };
  renditions: Array<
    VideoArtifactProfile & {
      playlistObjectKey: string;
      playlistRelativePath: string;
      segmentPrefix: string;
      segmentRelativeDirectory: string;
    }
  >;
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

export const videoOriginalKey = (
  userId: string,
  videoId: string,
  uploadSessionId: string,
): string => {
  assertObjectKeySegment('uploadSessionId', uploadSessionId);

  return `${videoBasePrefix(userId, videoId)}/sources/${uploadSessionId}/original.mp4`;
};

export const buildVideoArtifactManifest = (
  userId: string,
  videoId: string,
  generationId: string,
  profiles: readonly VideoArtifactProfile[],
): VideoArtifactManifest => {
  assertObjectKeySegment('generationId', generationId);
  const rootPrefix = `${videoBasePrefix(userId, videoId)}/generations/${generationId}/`;
  const hlsPrefix = `${rootPrefix}hls/`;
  const thumbnailPrefix = `${rootPrefix}thumbnail/`;

  return {
    hlsPrefix,
    master: {
      objectKey: `${hlsPrefix}master.m3u8`,
      relativePath: 'hls/master.m3u8',
    },
    thumbnailPrefix,
    thumbnail: {
      objectKey: `${thumbnailPrefix}poster.webp`,
      relativePath: 'thumbnail/poster.webp',
    },
    renditions: profiles.map((profile) => {
      const renditionPrefix = `${hlsPrefix}${profile.quality}/`;

      return {
        ...profile,
        playlistObjectKey: `${renditionPrefix}index.m3u8`,
        playlistRelativePath: `hls/${profile.quality}/index.m3u8`,
        segmentPrefix: `${renditionPrefix}segments/`,
        segmentRelativeDirectory: `hls/${profile.quality}/segments`,
      };
    }),
  };
};
