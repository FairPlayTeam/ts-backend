import type { Prisma } from '@prisma/client';
import type { AdminDependencies } from './admin.dependencies.js';
import { toProfileMediaUrl } from '../userMedia/userMedia.profileAssets.js';
import { banAdminAccount } from './admin.accountBan.js';
import {
  DEFAULT_ADMIN_ACCOUNT_BAN_STATUS,
  type AdminAccountBanStatus,
} from './admin.accountFilters.js';
import { unbanAdminAccount } from './admin.accountUnban.js';
import { updateAdminAccountRole } from './admin.accountRoles.js';
import type {
  BanAdminAccountInput,
  BanAdminAccountResult,
  AdminAccountSummary,
  AdminAccountsPort,
  ListAdminAccountsInput,
  ListAdminAccountsResult,
  UnbanAdminAccountInput,
  UnbanAdminAccountResult,
  UpdateAdminAccountRoleInput,
  UpdateAdminAccountRoleResult,
} from './types/accounts.types.js';

const DEFAULT_ADMIN_ACCOUNTS_LIMIT = 20;
const MAX_ADMIN_ACCOUNTS_LIMIT = 100;

const adminAccountSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  isVerified: true,
  isBanned: true,
  bannedAt: true,
  createdAt: true,
  updatedAt: true,
  lastLogin: true,
  mediaAssets: {
    where: {
      kind: 'avatar',
    },
    select: {
      id: true,
    },
    take: 1,
  },
} satisfies Prisma.UserSelect;

type AccountRecord = Prisma.UserGetPayload<{ select: typeof adminAccountSelect }>;

const normalizeAdminAccountsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_ADMIN_ACCOUNTS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_ACCOUNTS_LIMIT);
};

const hasUserFilter = (filter: Prisma.UserWhereInput): boolean => Object.keys(filter).length > 0;

const combineUserFilters = (...filters: Prisma.UserWhereInput[]): Prisma.UserWhereInput => {
  const activeFilters = filters.filter(hasUserFilter);

  if (activeFilters.length === 0) {
    return {};
  }

  if (activeFilters.length === 1) {
    return activeFilters[0] ?? {};
  }

  return { AND: activeFilters };
};

const normalizeAdminAccountsSearch = (search: string | undefined): string | undefined => {
  const normalizedSearch = search?.trim();

  return normalizedSearch ? normalizedSearch : undefined;
};

const getSearchFilter = (search: string | undefined): Prisma.UserWhereInput => {
  const normalizedSearch = normalizeAdminAccountsSearch(search);

  if (!normalizedSearch) {
    return {};
  }

  return {
    OR: [
      { username: { contains: normalizedSearch, mode: 'insensitive' } },
      { displayName: { contains: normalizedSearch, mode: 'insensitive' } },
      { email: { contains: normalizedSearch, mode: 'insensitive' } },
    ],
  };
};

const getBanStatusFilter = (banStatus: AdminAccountBanStatus): Prisma.UserWhereInput => {
  if (banStatus === 'banned') {
    return { isBanned: true };
  }

  if (banStatus === 'notbanned') {
    return { isBanned: false };
  }

  return {};
};

const toAdminAccountSummary = (account: AccountRecord): AdminAccountSummary => {
  const { mediaAssets, ...accountSummary } = account;

  return {
    ...accountSummary,
    avatarUrl: toProfileMediaUrl(account.username, 'avatar', mediaAssets[0]),
  };
};

export const createAdminAccountsService = (deps: AdminDependencies): AdminAccountsPort => ({
  async listAccounts({
    banStatus = DEFAULT_ADMIN_ACCOUNT_BAN_STATUS,
    cursor,
    limit,
    search,
  }: ListAdminAccountsInput): Promise<ListAdminAccountsResult> {
    const pageSize = normalizeAdminAccountsLimit(limit);
    const searchFilter = getSearchFilter(search);
    const banStatusFilter = getBanStatusFilter(banStatus);
    const cursorFilter: Prisma.UserWhereInput = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {};
    const resultFilter = combineUserFilters(searchFilter, banStatusFilter);
    const pageFilter = combineUserFilters(searchFilter, banStatusFilter, cursorFilter);
    const countArgs = hasUserFilter(resultFilter) ? { where: resultFilter } : undefined;

    const [queriedAccounts, total] = await deps.prisma.$transaction([
      deps.prisma.user.findMany({
        where: pageFilter,
        select: adminAccountSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      }),
      deps.prisma.user.count(countArgs),
    ]);

    const accounts = queriedAccounts.slice(0, pageSize);
    const lastAccount = accounts.at(-1);
    const nextCursor =
      queriedAccounts.length > pageSize && lastAccount
        ? { createdAt: lastAccount.createdAt, id: lastAccount.id }
        : null;

    return {
      accounts: accounts.map(toAdminAccountSummary),
      total,
      nextCursor,
    };
  },

  async banAccount(input: BanAdminAccountInput): Promise<BanAdminAccountResult> {
    return banAdminAccount(deps, input);
  },

  async unbanAccount(input: UnbanAdminAccountInput): Promise<UnbanAdminAccountResult> {
    return unbanAdminAccount(deps, input);
  },

  async updateAccountRole(
    input: UpdateAdminAccountRoleInput,
  ): Promise<UpdateAdminAccountRoleResult> {
    return updateAdminAccountRole(deps, input);
  },
});
