import type { Prisma } from '@prisma/client';
import type { AdminDependencies } from './admin.dependencies.js';
import { banAdminAccount } from './admin.accountBan.js';
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
      objectKey: true,
    },
    take: 1,
  },
} satisfies Prisma.UserSelect;

type AccountRecord = Prisma.UserGetPayload<{ select: typeof adminAccountSelect }>;
type AccountMediaAsset = AccountRecord['mediaAssets'][number];

const normalizeAdminAccountsLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_ADMIN_ACCOUNTS_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_ACCOUNTS_LIMIT);
};

const getAvatarUrl = async (
  deps: AdminDependencies,
  mediaAssets: readonly AccountMediaAsset[],
): Promise<string | null> => {
  const avatar = mediaAssets[0];

  return avatar ? deps.objectStorage.getSignedUrl(avatar.objectKey) : null;
};

const toAdminAccountSummary = async (
  deps: AdminDependencies,
  account: AccountRecord,
): Promise<AdminAccountSummary> => {
  const { mediaAssets, ...accountSummary } = account;

  return {
    ...accountSummary,
    avatarUrl: await getAvatarUrl(deps, mediaAssets),
  };
};

export const createAdminAccountsService = (deps: AdminDependencies): AdminAccountsPort => ({
  async listAccounts({ cursor, limit }: ListAdminAccountsInput): Promise<ListAdminAccountsResult> {
    const pageSize = normalizeAdminAccountsLimit(limit);
    const cursorFilter: Prisma.UserWhereInput = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {};

    const [queriedAccounts, total] = await deps.prisma.$transaction([
      deps.prisma.user.findMany({
        where: cursorFilter,
        select: adminAccountSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      }),
      deps.prisma.user.count(),
    ]);

    const accounts = queriedAccounts.slice(0, pageSize);
    const lastAccount = accounts.at(-1);
    const nextCursor =
      queriedAccounts.length > pageSize && lastAccount
        ? { createdAt: lastAccount.createdAt, id: lastAccount.id }
        : null;

    return {
      accounts: await Promise.all(accounts.map((account) => toAdminAccountSummary(deps, account))),
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
