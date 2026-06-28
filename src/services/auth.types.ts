import type { AuthRole } from './auth.roles.js';

export type { AuthRole } from './auth.roles.js';

export type Session = {
  id: string;
  expiresAt: Date;
};

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: AuthRole;
};

export type AuthUserProfile = AuthUser & {
  avatarUrl: string | null;
  bannerUrl: string | null;
};

export type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

export type LoginInput = {
  emailOrUsername: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type VerifyEmailInput = {
  email: string;
  code: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type ResendVerificationInput = {
  email: string;
};

export type UpdateProfileInput = {
  userId: string;
  displayName?: string | null | undefined;
  bio?: string | null | undefined;
};

export type GetProfileInput = {
  userId: string;
};

export type UploadUserMediaInput = {
  userId: string;
  file: {
    buffer: Buffer;
    size: number;
  };
};

export type DeleteUserMediaInput = {
  userId: string;
};

export type UploadAvatarInput = UploadUserMediaInput;

export type DeleteAvatarInput = DeleteUserMediaInput;

export type UploadBannerInput = UploadUserMediaInput;

export type DeleteBannerInput = DeleteUserMediaInput;

export type UserMediaAssetResult = {
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: Date;
};

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
    kind: 'avatar' | 'banner';
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    width: number;
    height: number;
    createdAt: Date;
    updatedAt: Date;
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
};

export type AuthSessionResult = {
  message: string;
  user: AuthUser;
  sessionKey: string;
  session: Session;
};

export type UserSessionSummary = {
  id: string;
  sessionKeySuffix: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: string | null;
  isCurrent: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

export type CleanupSessionsResult = {
  message: string;
  sessionsDeleted: number;
};

export type CleanupExpiredAuthTokensInput = {
  expiredBefore: Date;
};

export type CleanupExpiredAuthTokensResult = {
  message: string;
  emailVerificationTokensDeleted: number;
  passwordResetTokensDeleted: number;
};

export type CleanupPendingUserMediaDeletionsInput = {
  pendingBefore: Date;
  limit?: number;
};

export type CleanupPendingUserMediaDeletionsResult = {
  message: string;
  mediaObjectsDeleted: number;
  mediaObjectDeletionJobsFailed: number;
};

export type ValidatedAuthSession = {
  user: AuthUser;
  session: AuthSessionResult['session'];
};

export type ListUserSessionsInput = {
  userId: string;
  currentSessionId: string;
  cursor?: { lastUsedAt: Date; id: string };
  limit?: number;
};

export type ListUserSessionsResult = {
  sessions: UserSessionSummary[];
  total: number;
  nextCursor: {
    lastUsedAt: Date;
    id: string;
  } | null;
};

export type LogoutAllSessionsInput = {
  userId: string;
  currentPassword: string;
};

export type LogoutOtherSessionsInput = {
  userId: string;
  currentSessionId: string;
  currentPassword: string;
};

export type LogoutSessionInput = {
  userId: string;
  sessionId: string;
};

export type CleanupSessionsInput = {
  expiredBefore: Date;
  inactiveUpdatedBefore: Date;
};

export type RequestPasswordResetInput = {
  email: string;
};

export type ResetPasswordInput = {
  email: string;
  code: string;
  password: string;
};

export type AuthCredentialsPort = {
  register: (input: RegisterInput) => Promise<{ message: string }>;
  login: (input: LoginInput) => Promise<AuthSessionResult>;
};

export type AuthEmailVerificationPort = {
  verifyEmail: (input: VerifyEmailInput) => Promise<AuthSessionResult>;
  resendVerification: (input: ResendVerificationInput) => Promise<{ message: string }>;
};

export type AuthPasswordResetPort = {
  requestPasswordReset: (input: RequestPasswordResetInput) => Promise<{ message: string }>;
  resetPassword: (
    input: ResetPasswordInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
};

export type AuthSessionValidationPort = {
  validateSession: (sessionKey: string) => Promise<ValidatedAuthSession | null>;
};

export type AuthProfilePort = {
  getProfile: (input: GetProfileInput) => Promise<{ user: AuthUserProfile }>;
  updateProfile: (input: UpdateProfileInput) => Promise<{ message: string; user: AuthUser }>;
};

export type AuthSessionManagementPort = {
  getUserSessions: (input: ListUserSessionsInput) => Promise<ListUserSessionsResult>;
  logoutAllSessions: (
    input: LogoutAllSessionsInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutOtherSessions: (
    input: LogoutOtherSessionsInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
  logoutSession: (
    input: LogoutSessionInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
};

export type AuthProfileMediaPort = {
  uploadAvatar: (input: UploadAvatarInput) => Promise<{
    message: string;
    avatar: UserMediaAssetResult;
  }>;
  deleteAvatar: (input: DeleteAvatarInput) => Promise<{
    message: string;
    avatar: null;
  }>;
  uploadBanner: (input: UploadBannerInput) => Promise<{
    message: string;
    banner: UserMediaAssetResult;
  }>;
  deleteBanner: (input: DeleteBannerInput) => Promise<{
    message: string;
    banner: null;
  }>;
};

export type AuthAccountPort = {
  exportUserData: (input: ExportUserDataInput) => Promise<ExportUserDataResult>;
  deleteAccount: (input: DeleteAccountInput) => Promise<DeleteAccountResult>;
};

export type AuthMaintenancePort = {
  cleanupSessions: (input: CleanupSessionsInput) => Promise<CleanupSessionsResult>;
  cleanupExpiredAuthTokens: (
    input: CleanupExpiredAuthTokensInput,
  ) => Promise<CleanupExpiredAuthTokensResult>;
  cleanupPendingUserMediaDeletions: (
    input: CleanupPendingUserMediaDeletionsInput,
  ) => Promise<CleanupPendingUserMediaDeletionsResult>;
};

export type AuthControllerPort = AuthCredentialsPort &
  AuthEmailVerificationPort &
  AuthPasswordResetPort &
  AuthProfilePort &
  AuthSessionManagementPort &
  AuthProfileMediaPort &
  AuthAccountPort;

export type AuthRoutePort = AuthControllerPort & AuthSessionValidationPort;

export type AuthPorts = AuthRoutePort & AuthMaintenancePort;
