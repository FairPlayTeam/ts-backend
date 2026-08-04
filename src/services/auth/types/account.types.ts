import type { AuthRole } from './user.types.js';
import type { UserMediaKind } from '../../userMedia/userMedia.types.js';

export type ExportUserDataInput = {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
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
  videoRatings: {
    videoId: string;
    value: number;
    createdAt: Date;
    updatedAt: Date;
  }[];
  videoViews: {
    videoId: string;
    viewedOn: Date;
  }[];
  sessions: {
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
  }[];
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
