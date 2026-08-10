import type { AuthRole } from './user.types.js';
import type { UserMediaKind } from '../../userMedia/userMedia.types.js';

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
    createdAt: Date;
    updatedAt: Date;
    lastLogin: Date | null;
  };
  mediaAssets: {
    id: string;
    kind: UserMediaKind;
    url: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    createdAt: Date;
    updatedAt: Date;
  }[];
  videoRatings: AsyncIterable<ExportUserVideoRatingData>;
  videoViews: AsyncIterable<ExportUserVideoViewData>;
  comments: AsyncIterable<ExportUserCommentData>;
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
