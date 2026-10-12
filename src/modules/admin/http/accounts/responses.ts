import { toIsoString, toNullableIsoString } from '../../../../controllers/http.responses.js';
import type {
  BanAdminAccountResult,
  ListAdminAccountsResult,
  UnbanAdminAccountResult,
  UpdateAdminAccountRoleResult,
} from '../../accounts/types.js';

export const toAdminAccountsResponse = ({
  accounts,
  nextCursor,
  total,
}: ListAdminAccountsResult) => ({
  accounts: accounts.map((account) => ({
    id: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    createdAt: toIsoString(account.createdAt),
    isVerified: account.isVerified,
    isBanned: account.isBanned,
    bannedAt: toNullableIsoString(account.bannedAt),
    lastLogin: toNullableIsoString(account.lastLogin),
    updatedAt: toIsoString(account.updatedAt),
    role: account.role,
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
    id: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    isBanned: account.isBanned,
    bannedAt: toIsoString(account.bannedAt),
    banReason: account.banReason,
  },
  sessionsRevoked,
  notificationEmailSent,
});

export const toUnbanAdminAccountResponse = ({ account, message }: UnbanAdminAccountResult) => ({
  message,
  account: {
    id: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    isBanned: account.isBanned,
    bannedAt: toNullableIsoString(account.bannedAt),
    banReason: account.banReason,
  },
});

export const toUpdateAdminAccountRoleResponse = ({
  account,
  message,
}: UpdateAdminAccountRoleResult) => ({
  message,
  account: {
    id: account.id,
    email: account.email,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    updatedAt: toIsoString(account.updatedAt),
  },
});
