import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type { BanAdminAccountResult, ListAdminAccountsResult } from '../../services/admin.types.js';

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
