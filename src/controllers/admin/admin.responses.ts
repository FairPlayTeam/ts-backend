import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type { ListAdminAccountsResult } from '../../services/admin.types.js';

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
