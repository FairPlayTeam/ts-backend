import type { VideoLicense } from '../videoLicenses.js';
import type { AuthRole } from '../../auth.roles.js';
import type { PublicProfileIdentity } from '../../profiles/types/profile.types.js';

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

export type VideoPaginationCursor = {
  createdAt: Date;
  id: string;
};

export type PublicVideoCursor = {
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

export type VideoCommentAuthor = PublicProfileIdentity;

type VideoCommentBase = {
  id: string;
  createdAt: Date;
  rootCommentId: string | null;
  likeCount: number;
  viewerHasLiked: boolean;
};

export type ActiveVideoComment = VideoCommentBase & {
  content: string;
  isDeleted: false;
  replyingTo: {
    commentId: string;
    username: string;
  } | null;
  author: VideoCommentAuthor;
};

export type DeletedVideoCommentPlaceholder = VideoCommentBase & {
  content: null;
  isDeleted: true;
  rootCommentId: null;
  replyingTo: null;
  author: null;
};

export type VideoComment = ActiveVideoComment | DeletedVideoCommentPlaceholder;

export type VideoCommentRoot = VideoComment & {
  rootCommentId: null;
  replyCount: number;
};

export type VideoCommentReply = ActiveVideoComment & {
  rootCommentId: string;
};

export type VideoCommentCursor = {
  createdAt: Date;
  id: string;
};

export type CreateVideoCommentInput = {
  publicId: string;
  userId: string;
  content: string;
};

export type CreateVideoCommentReplyInput = CreateVideoCommentInput & {
  rootCommentId: string;
  replyingToCommentId?: string;
};

export type CreateVideoCommentResult = {
  comment: ActiveVideoComment;
};

export type ListVideoCommentsInput = {
  publicId: string;
  viewerUserId?: string;
  cursor?: VideoCommentCursor;
  limit?: number;
};

export type ListVideoCommentRepliesInput = ListVideoCommentsInput & {
  rootCommentId: string;
};

export type ListVideoCommentsResult = {
  comments: VideoCommentRoot[];
  total: number;
  nextCursor: VideoCommentCursor | null;
};

export type ListVideoCommentRepliesResult = {
  replies: VideoCommentReply[];
  total: number;
  nextCursor: VideoCommentCursor | null;
};

export type DeleteVideoCommentInput = {
  publicId: string;
  commentId: string;
  userId: string;
  actorRole: AuthRole;
};

export type MutateVideoCommentLikeInput = {
  publicId: string;
  commentId: string;
  userId: string;
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
  createVideoComment(input: CreateVideoCommentInput): Promise<CreateVideoCommentResult>;
  createVideoCommentReply(input: CreateVideoCommentReplyInput): Promise<CreateVideoCommentResult>;
  listVideoComments(input: ListVideoCommentsInput): Promise<ListVideoCommentsResult>;
  listVideoCommentReplies(
    input: ListVideoCommentRepliesInput,
  ): Promise<ListVideoCommentRepliesResult>;
  deleteVideoComment(input: DeleteVideoCommentInput): Promise<void>;
  likeVideoComment(input: MutateVideoCommentLikeInput): Promise<void>;
  unlikeVideoComment(input: MutateVideoCommentLikeInput): Promise<void>;
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
  deleteExpiredVideosPendingPurge(input: { observedAt: Date; purgeBefore: Date }): Promise<{
    videosPendingPurgeDeleted: number;
    videoPendingPurgeTargetsScheduled: number;
  }>;
};

export type VideosService = VideosPorts & VideoMaintenancePort;
