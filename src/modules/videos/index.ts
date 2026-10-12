import { createVideoCatalogService } from './catalog.js';
import { createVideoLifecycleService } from './lifecycle.js';
import { createVideoManagementService } from './management.js';
import { createVideoPlaybackService } from './playback.js';
import { createVideoRatingsService } from './ratings.js';
import type { VideosDependencies } from './dependencies.js';
import type { VideosService } from './types.js';

export const createVideosService = (deps: VideosDependencies): VideosService => ({
  ...createVideoManagementService(deps),
  ...createVideoCatalogService(deps),
  ...createVideoRatingsService(deps),
  ...createVideoPlaybackService(deps),
  ...createVideoLifecycleService(deps),
});

export { videosHttpModule } from './module.js';
export type { VideosDependencies } from './dependencies.js';
export type {
  CreateVideoInput,
  CreateVideoResult,
  CreatedVideo,
  DeleteVideoInput,
  GetMyVideoRatingInput,
  GetPublicVideoDetailInput,
  GetPublicVideoDetailResult,
  GetVideoHlsMasterInput,
  GetVideoHlsRenditionInput,
  GetVideoHlsSegmentInput,
  GetVideoRatingInput,
  GetVideoThumbnailInput,
  ListMyVideosInput,
  ListMyVideosResult,
  ListPublicProfileVideosInput,
  ListPublicVideosInput,
  ListPublicVideosResult,
  MyVideo,
  PublicCreatorSearchSummary,
  PublicProfileIdentity,
  PublicVideoCursor,
  PublicVideoDetail,
  PublicVideoFeedCard,
  PublicVideoSearchSort,
  PublicVideoSearchSummary,
  RateVideoInput,
  SearchPublicVideosInput,
  SearchPublicVideosResult,
  VideoHlsPlaylistResult,
  VideoHlsSegmentResult,
  VideoLifecycleMaintenancePort,
  VideoModerationStatus,
  VideoPaginationCursor,
  VideoProcessingStatus,
  VideoRatingAggregateResult,
  VideoRatingResult,
  VideoThumbnailResult,
  VideoVisibility,
  VideosRoutePort,
  VideosService,
  PublicProfileVideosPort,
} from './types.js';
export {
  publicVideoIdParamsSchema,
  publicVideosQuerySchema,
  publicVideosResponseSchema,
} from './http/schemas.js';
export { toPublicVideosResponse } from './http/responses.js';
export {
  VIDEO_DELETION_TEMPORARILY_UNAVAILABLE_MESSAGE,
  VIDEO_RATING_TEMPORARILY_UNAVAILABLE_MESSAGE,
  VIDEO_SELF_RATING_FORBIDDEN_MESSAGE,
  VideoDeletionTemporarilyUnavailableError,
  VideoRatingTemporarilyUnavailableError,
  VideoSelfRatingForbiddenError,
} from './errors.js';
