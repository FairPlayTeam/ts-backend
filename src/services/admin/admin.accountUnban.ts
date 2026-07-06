import type { Prisma } from '@prisma/client';
import {
  AdminAccountNotBannedError,
  AdminAccountNotFoundError,
  AdminRoleHierarchyError,
  AdminSelfUnbanError,
} from '../admin.errors.js';
import type { AdminDependencies } from './admin.dependencies.js';
import { UNBAN_ACCOUNT_SUCCESS_MESSAGE } from './admin.messages.js';
import { canManageRole, getManageableRoles } from './admin.roleHierarchy.js';
import type {
  UnbanAdminAccountInput,
  UnbanAdminAccountResult,
  UnbannedAdminAccount,
} from './types/accounts.types.js';

const unbannedAccountSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  isBanned: true,
  bannedAt: true,
  banReason: true,
} satisfies Prisma.UserSelect;

type UnbannedAccountRecord = Prisma.UserGetPayload<{ select: typeof unbannedAccountSelect }>;

const toUnbannedAdminAccount = (account: UnbannedAccountRecord): UnbannedAdminAccount => {
  if (account.isBanned || account.bannedAt !== null || account.banReason !== null) {
    throw new Error(`Unban state was not persisted for account ${account.id}`);
  }

  return {
    ...account,
    isBanned: false,
    bannedAt: null,
    banReason: null,
  };
};

export const unbanAdminAccount = async (
  deps: AdminDependencies,
  { actorRole, actorUserId, targetUserId }: UnbanAdminAccountInput,
): Promise<UnbanAdminAccountResult> => {
  if (actorUserId === targetUserId) {
    throw new AdminSelfUnbanError();
  }

  const unbannableRoles = getManageableRoles(actorRole);

  const account = await deps.prisma.$transaction(async (tx) => {
    const existingAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, isBanned: true, role: true },
    });

    if (!existingAccount) {
      throw new AdminAccountNotFoundError();
    }

    if (!existingAccount.isBanned) {
      throw new AdminAccountNotBannedError();
    }

    if (!canManageRole(actorRole, existingAccount.role)) {
      throw new AdminRoleHierarchyError();
    }

    const updated = await tx.user.updateMany({
      where: {
        id: targetUserId,
        isBanned: true,
        role: { in: unbannableRoles },
      },
      data: {
        isBanned: false,
        bannedAt: null,
        banReason: null,
      },
    });

    if (updated.count !== 1) {
      const currentAccount = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { isBanned: true, role: true },
      });

      if (!currentAccount) {
        throw new AdminAccountNotFoundError();
      }

      if (!currentAccount.isBanned) {
        throw new AdminAccountNotBannedError();
      }

      if (!canManageRole(actorRole, currentAccount.role)) {
        throw new AdminRoleHierarchyError();
      }

      throw new Error(`Account unban could not be applied for account ${targetUserId}`);
    }

    const unbannedAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: unbannedAccountSelect,
    });

    if (!unbannedAccount) {
      throw new AdminAccountNotFoundError();
    }

    return toUnbannedAdminAccount(unbannedAccount);
  });

  return {
    message: UNBAN_ACCOUNT_SUCCESS_MESSAGE,
    account,
  };
};
