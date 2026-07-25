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
  license: string;
  visibility: VideoVisibility;
  allowComments: boolean;
  processingStatus: VideoProcessingStatus;
  moderationStatus: VideoModerationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type VideoPaginationCursor = {
  createdAt: Date;
  id: string;
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
  license: string;
  visibility: VideoVisibility;
  allowComments: boolean;
};

export type ListMyVideosInput = {
  userId: string;
  cursor?: VideoPaginationCursor;
  limit?: number;
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

export type VideosRoutePort = {
  createVideo(input: CreateVideoInput): Promise<CreateVideoResult>;
  listMyVideos(input: ListMyVideosInput): Promise<ListMyVideosResult>;
  getHlsMaster(input: GetVideoHlsMasterInput): Promise<VideoHlsPlaylistResult>;
  getHlsRendition(input: GetVideoHlsRenditionInput): Promise<VideoHlsPlaylistResult>;
  getHlsSegment(input: GetVideoHlsSegmentInput): Promise<VideoHlsSegmentResult>;
  initMultipartUpload(input: InitVideoMultipartUploadInput): Promise<VideoUploadSessionResult>;
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
};

export type VideosService = VideosPorts & VideoMaintenancePort;
