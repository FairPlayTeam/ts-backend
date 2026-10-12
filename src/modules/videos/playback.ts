import {
  buildVideoArtifactManifest,
  videoHlsSegmentObjectKey,
  type VideoObjectKeyQuality,
} from './shared/objectKeys.js';
import {
  isVideoHlsGenerationToken,
  parseVideoHlsQuality,
  parseVideoHlsSegmentName,
  rewriteVideoHlsMasterPlaylist,
  rewriteVideoHlsRenditionPlaylist,
  toVideoObjectKeyQuality,
  toVideoRenditionQuality,
  VIDEO_HLS_PLAYLIST_MAX_BYTES,
} from './shared/hls.js';
import { assertValidPublicVideoId } from './shared/publicId.js';
import { readableVideoWhere } from './shared/readability.js';
import { VideoNotFoundError } from './shared/errors.js';
import { readForProxy, resolveSignedRedirect } from '../../services/assets/assetLinks.js';
import type { VideosDependencies } from './dependencies.js';
import type {
  GetVideoHlsMasterInput,
  GetVideoHlsRenditionInput,
  GetVideoHlsSegmentInput,
  GetVideoThumbnailInput,
  VideoHlsPlaylistResult,
  VideoHlsSegmentResult,
  VideoThumbnailResult,
  VideosRoutePort,
} from './types.js';

const findPublicHlsRendition = async (
  deps: VideosDependencies,
  {
    generationToken,
    publicId,
    quality,
  }: {
    generationToken: string;
    publicId: string;
    quality: VideoObjectKeyQuality;
  },
) => {
  assertValidPublicVideoId(publicId);

  if (!isVideoHlsGenerationToken(generationToken)) {
    throw new VideoNotFoundError();
  }

  const persistedQuality = toVideoRenditionQuality(quality);
  const generation = await deps.prisma.videoArtifactGeneration.findFirst({
    where: {
      publicToken: generationToken,
      state: {
        in: ['active', 'retiring'],
      },
      video: {
        is: {
          publicId,
          ...readableVideoWhere,
        },
      },
      renditions: {
        some: {
          quality: persistedQuality,
        },
      },
    },
    select: {
      publicToken: true,
      bucket: true,
      renditions: {
        where: {
          quality: persistedQuality,
        },
        select: {
          quality: true,
          width: true,
          height: true,
          bitrate: true,
        },
        take: 1,
      },
    },
  });
  const persistedRendition = generation?.renditions[0];

  if (!generation || !persistedRendition) {
    throw new VideoNotFoundError();
  }

  const manifest = buildVideoArtifactManifest(generation.publicToken, [
    {
      quality: toVideoObjectKeyQuality(persistedRendition.quality),
      width: persistedRendition.width,
      height: persistedRendition.height,
      videoBitrate: persistedRendition.bitrate,
    },
  ]);
  const rendition = manifest.renditions[0];

  if (!rendition) {
    throw new VideoNotFoundError();
  }

  return {
    bucket: generation.bucket,
    rendition,
  };
};

export const createVideoPlaybackService = (deps: VideosDependencies) =>
  ({
    async getThumbnail({ publicId }: GetVideoThumbnailInput): Promise<VideoThumbnailResult> {
      assertValidPublicVideoId(publicId);

      const video = await deps.prisma.video.findFirst({
        where: {
          publicId,
          ...readableVideoWhere,
          activeArtifactGeneration: {
            is: {
              state: 'active',
            },
          },
        },
        select: {
          thumbnailObjectKey: true,
          activeArtifactGeneration: {
            select: {
              publicToken: true,
              bucket: true,
              thumbnailObjectKey: true,
            },
          },
        },
      });
      const generation = video?.activeArtifactGeneration;

      if (!video || !generation) {
        throw new VideoNotFoundError();
      }

      const objectKey = buildVideoArtifactManifest(generation.publicToken, []).thumbnail.objectKey;

      if (video.thumbnailObjectKey !== objectKey || generation.thumbnailObjectKey !== objectKey) {
        throw new VideoNotFoundError();
      }

      const url = await resolveSignedRedirect(deps.objectStorage, {
        bucket: generation.bucket,
        objectKey,
      });

      if (!url) {
        throw new VideoNotFoundError();
      }

      return {
        url,
      };
    },

    async getHlsMaster({ publicId }: GetVideoHlsMasterInput): Promise<VideoHlsPlaylistResult> {
      assertValidPublicVideoId(publicId);

      const video = await deps.prisma.video.findFirst({
        where: {
          publicId,
          ...readableVideoWhere,
          activeArtifactGeneration: {
            is: {
              state: 'active',
            },
          },
        },
        select: {
          activeArtifactGeneration: {
            select: {
              publicToken: true,
              bucket: true,
              renditions: {
                select: {
                  quality: true,
                  width: true,
                  height: true,
                  bitrate: true,
                },
              },
            },
          },
        },
      });
      const generation = video?.activeArtifactGeneration;

      if (!video || !generation || generation.renditions.length === 0) {
        throw new VideoNotFoundError();
      }

      const profiles = generation.renditions.map((rendition) => ({
        quality: toVideoObjectKeyQuality(rendition.quality),
        width: rendition.width,
        height: rendition.height,
        videoBitrate: rendition.bitrate,
      }));
      const manifest = buildVideoArtifactManifest(generation.publicToken, profiles);
      const storedPlaylist = await readForProxy(
        deps.objectStorage,
        {
          bucket: generation.bucket,
          objectKey: manifest.master.objectKey,
        },
        VIDEO_HLS_PLAYLIST_MAX_BYTES,
      );

      if (!storedPlaylist) {
        throw new VideoNotFoundError();
      }

      return {
        playlist: rewriteVideoHlsMasterPlaylist(storedPlaylist.toString('utf8'), {
          publicId,
          generationToken: generation.publicToken,
          qualities: profiles.map(({ quality }) => quality),
        }),
      };
    },

    async getHlsRendition({
      generationToken,
      publicId,
      quality: rawQuality,
    }: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult> {
      const quality = parseVideoHlsQuality(rawQuality);

      if (!quality) {
        throw new VideoNotFoundError();
      }

      const { bucket, rendition } = await findPublicHlsRendition(deps, {
        generationToken,
        publicId,
        quality,
      });
      const storedPlaylist = await readForProxy(
        deps.objectStorage,
        {
          bucket,
          objectKey: rendition.playlistObjectKey,
        },
        VIDEO_HLS_PLAYLIST_MAX_BYTES,
      );

      if (!storedPlaylist) {
        throw new VideoNotFoundError();
      }

      return {
        playlist: rewriteVideoHlsRenditionPlaylist(storedPlaylist.toString('utf8'), {
          publicId,
          generationToken,
          quality,
        }),
      };
    },

    async getHlsSegment({
      generationToken,
      publicId,
      quality: rawQuality,
      segment: rawSegment,
    }: GetVideoHlsSegmentInput): Promise<VideoHlsSegmentResult> {
      const quality = parseVideoHlsQuality(rawQuality);
      const segment = parseVideoHlsSegmentName(rawSegment);

      if (!quality || !segment) {
        throw new VideoNotFoundError();
      }

      const { bucket, rendition } = await findPublicHlsRendition(deps, {
        generationToken,
        publicId,
        quality,
      });
      const objectKey = videoHlsSegmentObjectKey(rendition, segment);
      const url = await resolveSignedRedirect(deps.objectStorage, {
        bucket,
        objectKey,
      });

      if (!url) {
        throw new VideoNotFoundError();
      }

      return {
        url,
      };
    },
  }) satisfies Pick<
    VideosRoutePort,
    'getThumbnail' | 'getHlsMaster' | 'getHlsRendition' | 'getHlsSegment'
  >;
