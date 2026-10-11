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

export const ACTIVE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSessionStatus[] = [
  'initializing',
  'initiated',
  'uploading',
  'completing',
] as const satisfies readonly VideoUploadSessionStatus[];

export const EXPIRABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSessionStatus[] = [
  'initializing',
  'initiated',
  'uploading',
] as const satisfies readonly VideoUploadSessionStatus[];

export const SIGNABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSessionStatus[] = [
  'initiated',
  'uploading',
] as const satisfies readonly VideoUploadSessionStatus[];

export const SOURCE_THUMBNAIL_UPLOAD_SESSION_STATUSES: readonly VideoUploadSessionStatus[] = [
  'initiated',
  'uploading',
] as const satisfies readonly VideoUploadSessionStatus[];

export const ABORTABLE_UPLOAD_SESSION_STATUSES: readonly VideoUploadSessionStatus[] = [
  'initializing',
  'initiated',
  'uploading',
  'completing',
] as const satisfies readonly VideoUploadSessionStatus[];

export const VIDEO_SOURCE_THUMBNAIL_CONTENT_TYPE = 'image/webp';

export type VideoUploadPart = {
  partNumber: number;
  etag: string;
  sizeBytes: number | null;
  createdAt: Date;
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

export type SignVideoMultipartUploadPartsResult = {
  uploadSessionId: string;
  parts: {
    partNumber: number;
    url: string;
  }[];
};

export type VideoUploadsPort = {
  initMultipartUpload(input: InitVideoMultipartUploadInput): Promise<VideoUploadSessionResult>;
  signMultipartUploadParts(
    input: SignVideoMultipartUploadPartsInput,
  ): Promise<SignVideoMultipartUploadPartsResult>;
  uploadSourceThumbnail(
    input: UploadVideoSourceThumbnailInput,
  ): Promise<UploadVideoSourceThumbnailResult>;
  completeMultipartUpload(
    input: CompleteVideoMultipartUploadInput,
  ): Promise<VideoUploadSessionResult>;
  abortMultipartUpload(input: AbortVideoMultipartUploadInput): Promise<VideoUploadSessionResult>;
  getMultipartUploadSession(
    input: GetVideoMultipartUploadSessionInput,
  ): Promise<VideoUploadSessionResult>;
};

export type VideoUploadsMaintenancePort = {
  expireMultipartUploadSessions(input: { expiredBefore: Date }): Promise<{
    uploadSessionsExpired: number;
  }>;
};
