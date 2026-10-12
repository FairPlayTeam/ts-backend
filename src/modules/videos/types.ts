import type { VideoLicense } from './shared/licenses.js';
import type { PublicProfileIdentity as ProfilesPublicProfileIdentity } from '../profiles/types.js';

export type VideoVisibility = 'public' | 'unlisted';

export type PublicProfileIdentity = ProfilesPublicProfileIdentity;

export type VideoProcessingStatus =
  'draft' | 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

export type VideoModerationStatus = 'pending' | 'approved' | 'rejected';

export type CreatedVideo = {
  id: string;
  publicId: string;
  ownerId: string;
  title: string;
  description: string | null;
  tags: string[];
  license: VideoLicense;
  visibility: VideoVisibility;
  allowComments: boolean;
  processingStatus: VideoProcessingStatus;
  moderationStatus: VideoModerationStatus;
  thumbnailPath: string | null;
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type MyVideo = CreatedVideo & {
  deletionRequestedAt: Date | null;
};

export type VideoPaginationCursor = {
  createdAt: Date;
  publicId: string;
};

export type PublicVideoCursor = {
  createdAt: Date;
  publicId: string;
};

export type CreateVideoInput = {
  userId: string;
  title: string;
  description?: string | null;
  tags: string[];
  license: VideoLicense;
  allowComments: boolean;
};

export type DeleteVideoInput = {
  publicId: string;
  userId: string;
};

export type ListMyVideosInput = {
  userId: string;
  cursor?: VideoPaginationCursor;
  limit?: number;
};

export type PublicVideoSearchSort = 'newest' | 'oldest';

export type SearchPublicVideosInput = {
  search: string;
  cursor?: PublicVideoCursor;
  limit?: number;
  sort?: PublicVideoSearchSort;
};

export type ListPublicVideosInput = {
  cursor?: PublicVideoCursor;
  limit?: number;
};

export type ListPublicProfileVideosInput = ListPublicVideosInput & {
  ownerId: string;
};

export type PublicVideoSearchSummary = {
  publicId: string;
  title: string;
  description: string | null;
  tags: string[];
  username: string;
  thumbnailPath: string | null;
  ratingAverage: number;
  ratingCount: number;
  publishedAt: Date | null;
  createdAt: Date;
};

export type PublicCreatorSearchSummary = PublicProfileIdentity & {
  followerCount: number;
  videoCount: number;
  createdAt: Date;
};

export type PublicVideoFeedCard = {
  publicId: string;
  title: string;
  createdAt: Date;
  thumbnailPath: string | null;
  creator: Omit<PublicProfileIdentity, 'avatarUrl'>;
  viewCount: number;
  duration: number;
};

export type PublicVideoDetail = Pick<
  PublicVideoSearchSummary,
  | 'publicId'
  | 'title'
  | 'description'
  | 'tags'
  | 'ratingAverage'
  | 'ratingCount'
  | 'thumbnailPath'
  | 'publishedAt'
  | 'createdAt'
> & {
  license: VideoLicense;
  visibility: VideoVisibility;
  creator: PublicProfileIdentity;
  userRating: number | null;
  viewCount: number;
  commentCount: number;
  commentsOpen: boolean;
  duration: number;
  hlsMasterPath: string;
};

export type GetPublicVideoDetailInput = {
  publicId: string;
  userId?: string;
};

export type GetPublicVideoDetailResult = {
  video: PublicVideoDetail;
};

export type SearchPublicVideosResult = {
  videos: PublicVideoSearchSummary[];
  creators: PublicCreatorSearchSummary[];
  total: number;
  nextCursor: PublicVideoCursor | null;
};

export type ListPublicVideosResult = {
  videos: PublicVideoFeedCard[];
  total: number;
  nextCursor: PublicVideoCursor | null;
};

export type CreateVideoResult = {
  video: CreatedVideo;
};

export type ListMyVideosResult = {
  videos: MyVideo[];
  total: number;
  nextCursor: VideoPaginationCursor | null;
};

export type GetVideoHlsMasterInput = {
  publicId: string;
};

export type GetVideoThumbnailInput = {
  publicId: string;
};

export type GetVideoHlsRenditionInput = {
  publicId: string;
  generationToken: string;
  quality: string;
};

export type GetVideoHlsSegmentInput = GetVideoHlsRenditionInput & {
  segment: string;
};

export type VideoHlsPlaylistResult = {
  playlist: string;
};

export type VideoHlsSegmentResult = {
  url: string;
};

export type VideoThumbnailResult = {
  url: string;
};

export type GetVideoRatingInput = {
  publicId: string;
};

export type GetMyVideoRatingInput = GetVideoRatingInput & {
  userId: string;
};

export type RateVideoInput = GetMyVideoRatingInput & {
  value: number;
};

export type VideoRatingAggregateResult = {
  ratingAverage: number;
  ratingCount: number;
};

export type VideoRatingResult = VideoRatingAggregateResult & {
  userRating: number | null;
};

export type VideosRoutePort = {
  createVideo(input: CreateVideoInput): Promise<CreateVideoResult>;
  deleteVideo(input: DeleteVideoInput): Promise<void>;
  listMyVideos(input: ListMyVideosInput): Promise<ListMyVideosResult>;
  listPublicVideos(input: ListPublicVideosInput): Promise<ListPublicVideosResult>;
  listPublicProfileVideos(input: ListPublicProfileVideosInput): Promise<ListPublicVideosResult>;
  searchPublicVideos(input: SearchPublicVideosInput): Promise<SearchPublicVideosResult>;
  getPublicVideoDetail(input: GetPublicVideoDetailInput): Promise<GetPublicVideoDetailResult>;
  getVideoRating(input: GetVideoRatingInput): Promise<VideoRatingAggregateResult>;
  getMyVideoRating(input: GetMyVideoRatingInput): Promise<VideoRatingResult>;
  rateVideo(input: RateVideoInput): Promise<VideoRatingResult>;
  getThumbnail(input: GetVideoThumbnailInput): Promise<VideoThumbnailResult>;
  getHlsMaster(input: GetVideoHlsMasterInput): Promise<VideoHlsPlaylistResult>;
  getHlsRendition(input: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult>;
  getHlsSegment(input: GetVideoHlsSegmentInput): Promise<VideoHlsSegmentResult>;
};

export type VideoLifecycleMaintenancePort = {
  deleteExpiredVideosPendingPurge(input: { observedAt: Date; purgeBefore: Date }): Promise<{
    videosPendingPurgeDeleted: number;
    videoPendingPurgeTargetsScheduled: number;
  }>;
};

export type VideosService = VideosRoutePort & VideoLifecycleMaintenancePort;

export type PublicProfileVideosPort = Pick<VideosRoutePort, 'listPublicProfileVideos'>;
