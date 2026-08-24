import type {
  VideoModerationStatus,
  VideoProcessingStatus,
  VideoVisibility,
} from '../../videos.types.js';

export type AdminVideoSort = 'newest' | 'oldest';
export type VideoDeletionOrigin = 'moderator' | 'admin';

export type ListAdminVideosInput = {
  cursor?: {
    createdAt: Date;
    id: string;
  };
  limit?: number;
  moderationStatus?: VideoModerationStatus;
  processingStatus?: VideoProcessingStatus;
  search?: string;
  sort?: AdminVideoSort;
};

export type AdminVideoSummary = {
  id: string;
  publicId: string;
  ownerId: string;
  username: string;
  title: string;
  moderationStatus: VideoModerationStatus;
  processingStatus: VideoProcessingStatus;
  visibility: VideoVisibility;
  createdAt: Date;
  thumbnailPath: string | null;
  publishedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  deletionRequestedAt: Date | null;
  deletionReason: string | null;
  deletionOrigin: VideoDeletionOrigin | null;
};

export type ListAdminVideosResult = {
  videos: AdminVideoSummary[];
  total: number;
  nextCursor: {
    createdAt: Date;
    id: string;
  } | null;
};

export type ModerateAdminVideoInput =
  | {
      videoId: string;
      decision: 'approved';
    }
  | {
      videoId: string;
      decision: 'rejected';
      reason: string;
    };

export type ModerateAdminVideoResult = {
  video: AdminVideoSummary;
};

export type RequestAdminVideoDeletionInput = {
  actorRole: VideoDeletionOrigin;
  reason: string;
  videoId: string;
};

export type RequestAdminVideoDeletionResult = {
  video: AdminVideoSummary;
};

export type AdminVideosPort = {
  listVideos(input: ListAdminVideosInput): Promise<ListAdminVideosResult>;
  moderateVideo(input: ModerateAdminVideoInput): Promise<ModerateAdminVideoResult>;
  requestVideoDeletion(
    input: RequestAdminVideoDeletionInput,
  ): Promise<RequestAdminVideoDeletionResult>;
};
