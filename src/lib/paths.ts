export const userRoot = (userId: string) => `${userId}/`;

export const videoBase = (userId: string, videoId: string) =>
  `${userId}/${videoId}`;
export const videoOriginalPath = (userId: string, videoId: string) =>
  `${videoBase(userId, videoId)}/original.mp4`;
export const videoQualityPath = (
  userId: string,
  videoId: string,
  quality: string,
) => `${videoBase(userId, videoId)}/${quality}.mp4`;

export const hlsVariantDir = (
  userId: string,
  videoId: string,
  quality: string,
) => `${videoBase(userId, videoId)}/${quality}`;
export const hlsVariantIndex = (
  userId: string,
  videoId: string,
  quality: string,
) => `${hlsVariantDir(userId, videoId, quality)}/index.m3u8`;
export const hlsVariantSegment = (
  userId: string,
  videoId: string,
  quality: string,
  indexPattern: string = 'segment_%03d.ts',
) => `${hlsVariantDir(userId, videoId, quality)}/${indexPattern}`;
export const hlsMasterIndex = (userId: string, videoId: string) =>
  `${videoBase(userId, videoId)}/master.m3u8`;

export const profileBase = (userId: string) => `${userId}/profile`;
export const avatarPath = (userId: string, ext: string) =>
  `${profileBase(userId)}/avatar.${ext}`;
export const bannerPath = (userId: string, ext: string) =>
  `${profileBase(userId)}/banner.${ext}`;
