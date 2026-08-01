import type { VideoLicense } from '../videoLicenses.js';

export type VideoUploadSessionStatus =
  | 'initializing'
  | 'initiated'
  | 'uploading'
  | 'completing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'expiring'
  | 'expired';

export type VideoVisibility = 'public' | 'unlisted';

export type VideoProcessingStatus =
  | 'draft'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed';

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
  thumbnailObjectKey: string | null;
  ratingAverage: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type VideoPaginationCursor = {
  createdAt: Date;
  id: string;
};

export type PublicVideoSearchCursor = {
  createdAt: Date;
  publicId: string;
};

export type VideoUploadPart = {
  partNumber: number;
  etag: string;
  sizeBytes: number | null;
  createdAt: Date;
};

export type CreateVideoInput = {
  userId: string;
  title: string;
  description?: string | null;
  tags: string[];
  license: VideoLicense;
  visibility: VideoVisibility;
  allowComments: boolean;
};

export type ListMyVideosInput = {
  userId: string;
  cursor?: VideoPaginationCursor;
  limit?: number;
};

export type PublicVideoSearchSort = 'newest' | 'oldest';

export type SearchPublicVideosInput = {
  search: string;
  cursor?: PublicVideoSearchCursor;
  limit?: number;
  sort?: PublicVideoSearchSort;
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

export type SearchPublicVideosResult = {
  videos: PublicVideoSearchSummary[];
  total: number;
  nextCursor: PublicVideoSearchCursor | null;
};

export type VideoUploadSession = {
  id: string;
  videoId: string;
  userId: string;
  status: VideoUploadSessionStatus;
  bucket: string;
  objectKey: string;
  uploadId: string | null;
  partSizeBytes: number;
  expectedSizeBytes: number;
  partCount: number | null;
  expiresAt: Date;
  completedAt: Date | null;
  abortedAt: Date | null;
  expiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  parts: VideoUploadPart[];
};

export type InitVideoMultipartUploadInput = {
  videoId: string;
  userId: string;
  sizeBytes: number;
};

export type SignVideoMultipartUploadPartsInput = {
  videoId: string;
  userId: string;
  uploadSessionId: string;
  partNumbers: number[];
};

export type CompleteVideoMultipartUploadInput = {
  videoId: string;
  userId: string;
  uploadSessionId: string;
  parts: {
    partNumber: number;
    etag: string;
  }[];
};

export type AbortVideoMultipartUploadInput = {
  videoId: string;
  userId: string;
  uploadSessionId: string;
};

export type GetVideoMultipartUploadSessionInput = {
  videoId: string;
  userId: string;
  uploadSessionId: string;
};

export type UploadVideoSourceThumbnailInput = GetVideoMultipartUploadSessionInput & {
  file: {
    buffer: Buffer;
    size: number;
  };
};

export type VideoSourceThumbnail = {
  id: string;
  uploadSessionId: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: Date;
  updatedAt: Date;
};

export type UploadVideoSourceThumbnailResult = {
  thumbnail: VideoSourceThumbnail;
};

export type VideoUploadSessionResult = {
  uploadSession: VideoUploadSession;
};

export type CreateVideoResult = {
  video: CreatedVideo;
};

export type ListMyVideosResult = {
  videos: CreatedVideo[];
  total: number;
  nextCursor: VideoPaginationCursor | null;
};

export type SignVideoMultipartUploadPartsResult = {
  uploadSessionId: string;
  parts: {
    partNumber: number;
    url: string;
  }[];
};

export type GetVideoHlsMasterInput = {
  publicId: string;
};

export type GetVideoThumbnailInput = {
  publicId: string;
};

export type GetVideoHlsRenditionInput = {
  publicId: string;
  generationId: string;
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
  listMyVideos(input: ListMyVideosInput): Promise<ListMyVideosResult>;
  searchPublicVideos(input: SearchPublicVideosInput): Promise<SearchPublicVideosResult>;
  getVideoRating(input: GetVideoRatingInput): Promise<VideoRatingAggregateResult>;
  getMyVideoRating(input: GetMyVideoRatingInput): Promise<VideoRatingResult>;
  rateVideo(input: RateVideoInput): Promise<VideoRatingResult>;
  getThumbnail(input: GetVideoThumbnailInput): Promise<VideoThumbnailResult>;
  getHlsMaster(input: GetVideoHlsMasterInput): Promise<VideoHlsPlaylistResult>;
  getHlsRendition(input: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult>;
  getHlsSegment(input: GetVideoHlsSegmentInput): Promise<VideoHlsSegmentResult>;
  initMultipartUpload(input: InitVideoMultipartUploadInput): Promise<VideoUploadSessionResult>;
  uploadSourceThumbnail(
    input: UploadVideoSourceThumbnailInput,
  ): Promise<UploadVideoSourceThumbnailResult>;
  signMultipartUploadParts(
    input: SignVideoMultipartUploadPartsInput,
  ): Promise<SignVideoMultipartUploadPartsResult>;
  completeMultipartUpload(
    input: CompleteVideoMultipartUploadInput,
  ): Promise<VideoUploadSessionResult>;
  abortMultipartUpload(input: AbortVideoMultipartUploadInput): Promise<VideoUploadSessionResult>;
  getMultipartUploadSession(
    input: GetVideoMultipartUploadSessionInput,
  ): Promise<VideoUploadSessionResult>;
};

export type VideosPorts = VideosRoutePort;

export type VideoMaintenancePort = {
  expireMultipartUploadSessions(input: { expiredBefore: Date }): Promise<{
    uploadSessionsExpired: number;
  }>;
  scheduleAbandonedArtifactGenerations(input: { observedAt: Date }): Promise<{
    artifactGenerationsScheduled: number;
  }>;
  reconcilePendingExternalResources(input?: { limit?: number }): Promise<{
    claimed: number;
    confirmed: number;
    redirectedAbsent: number;
    failed: number;
  }>;
  deleteExpiredRejectedVideos(input: { observedAt: Date; rejectedBefore: Date }): Promise<{
    rejectedVideosDeleted: number;
    rejectedVideoTargetsScheduled: number;
  }>;
};

export type VideosService = VideosPorts & VideoMaintenancePort;
