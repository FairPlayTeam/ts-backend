import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type {
  BanAdminAccountResult,
  ListAdminAccountsResult,
  ListAdminVideosResult,
  ModerateAdminVideoResult,
  RequestAdminVideoDeletionResult,
  UnbanAdminAccountResult,
  UpdateAdminAccountRoleResult,
} from '../../services/admin.types.js';

export const toAdminAccountsResponse = ({
  accounts,
  nextCursor,
  total,
}: ListAdminAccountsResult) => ({
  accounts: accounts.map((account) => ({
    ...account,
    createdAt: toIsoString(account.createdAt),
    bannedAt: toNullableIsoString(account.bannedAt),
    lastLogin: toNullableIsoString(account.lastLogin),
    updatedAt: toIsoString(account.updatedAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        createdAt: toIsoString(nextCursor.createdAt),
        id: nextCursor.id,
      }
    : null,
});

export const toBanAdminAccountResponse = ({
  account,
  message,
  notificationEmailSent,
  sessionsRevoked,
}: BanAdminAccountResult) => ({
  message,
  account: {
    ...account,
    bannedAt: toIsoString(account.bannedAt),
  },
  sessionsRevoked,
  notificationEmailSent,
});

export const toUnbanAdminAccountResponse = ({ account, message }: UnbanAdminAccountResult) => ({
  message,
  account,
});

export const toUpdateAdminAccountRoleResponse = ({
  account,
  message,
}: UpdateAdminAccountRoleResult) => ({
  message,
  account: {
    ...account,
    updatedAt: toIsoString(account.updatedAt),
  },
});

const toAdminVideoResponse = (video: ModerateAdminVideoResult['video']) => ({
  ...video,
  createdAt: toIsoString(video.createdAt),
  publishedAt: toNullableIsoString(video.publishedAt),
  rejectedAt: toNullableIsoString(video.rejectedAt),
  deletionRequestedAt: toNullableIsoString(video.deletionRequestedAt),
});

export const toAdminVideosResponse = ({ nextCursor, total, videos }: ListAdminVideosResult) => ({
  videos: videos.map(toAdminVideoResponse),
  total,
  nextCursor: nextCursor
    ? {
        createdAt: toIsoString(nextCursor.createdAt),
        id: nextCursor.id,
      }
    : null,
});

export const toModerateAdminVideoResponse = ({ video }: ModerateAdminVideoResult) => ({
  video: toAdminVideoResponse(video),
});

export const toRequestAdminVideoDeletionResponse = ({
  video,
}: RequestAdminVideoDeletionResult) => ({
  video: toAdminVideoResponse(video),
});
