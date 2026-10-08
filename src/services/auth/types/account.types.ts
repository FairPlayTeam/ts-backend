import type {
  VideoDeletionOrigin,
  VideoLicense,
  VideoModerationStatus,
  VideoProcessingStatus,
  VideoVisibility,
} from '@prisma/client';
import type { AuthRole } from './user.types.js';

export type ExportUserDataInput = {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
};

export type ExportUserCommentData = {
  id: string;
  videoId: string;
  content: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  rootId: string | null;
  replyingToCommentId: string | null;
};

export type ExportUserCommentLikeData = {
  commentId: string;
  createdAt: Date;
};

export type ExportUserVideoRatingData = {
  videoId: string;
  value: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExportUserVideoViewData = {
  videoId: string;
  viewedOn: Date;
};

export type ExportUserFollowData = {
  username: string;
  displayName: string | null;
  createdAt: Date;
};

export type ExportUserVideoData = {
  publicId: string;
  title: string;
  description: string | null;
  tags: string[];
  license: VideoLicense;
  visibility: VideoVisibility;
  allowComments: boolean;
  processingStatus: VideoProcessingStatus;
  moderationStatus: VideoModerationStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  viewCount: number;
  ratingCount: number;
  commentCount: number;
  publishedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  deletionRequestedAt: Date | null;
  deletionReason: string | null;
  deletionOrigin: VideoDeletionOrigin | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ExportUserSessionData = {
  id: string;
  sessionKeySuffix: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: string | null;
  isActive: boolean;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

export type ExportUserDataResult = {
  exportedAt: Date;
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string | null;
    bio: string | null;
    role: AuthRole;
    isVerified: boolean;
    isBanned: boolean;
    bannedAt: Date | null;
    banReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastLogin: Date | null;
  };
  following: AsyncIterable<ExportUserFollowData>;
  followers: AsyncIterable<ExportUserFollowData>;
  videos: AsyncIterable<ExportUserVideoData>;
  videoRatings: AsyncIterable<ExportUserVideoRatingData>;
  videoViews: AsyncIterable<ExportUserVideoViewData>;
  comments: AsyncIterable<ExportUserCommentData>;
  commentLikes: AsyncIterable<ExportUserCommentLikeData>;
  sessions: AsyncIterable<ExportUserSessionData>;
  emailVerificationToken: {
    id: string;
    createdAt: Date;
    expiresAt: Date;
  } | null;
  passwordResetToken: {
    id: string;
    createdAt: Date;
    expiresAt: Date;
  } | null;
};

export type DeleteAccountInput = {
  userId: string;
  currentPassword: string;
};

export type DeleteAccountResult = {
  message: string;
  mediaCleanupQueued: number;
  externalCleanupQueued?: number;
};

export type AuthAccountPort = {
  exportUserData: (input: ExportUserDataInput) => Promise<ExportUserDataResult>;
  deleteAccount: (input: DeleteAccountInput) => Promise<DeleteAccountResult>;
};
