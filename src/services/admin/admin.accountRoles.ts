import type { Prisma } from '@prisma/client';
import {
  AdminAccountNotFoundError,
  AdminRoleAlreadyAssignedError,
  AdminRoleAssignmentError,
  AdminRoleHierarchyError,
} from '../admin.errors.js';
import type { AdminDependencies } from './admin.dependencies.js';
import { UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE } from './admin.messages.js';
import { canAssignRole, canManageRole, getManageableRoles } from './admin.roleHierarchy.js';
import type {
  UpdateAdminAccountRoleInput,
  UpdateAdminAccountRoleResult,
} from './types/accounts.types.js';

const updatedAccountRoleSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const updateAdminAccountRole = async (
  deps: AdminDependencies,
  { actorRole, actorUserId, role, targetUserId }: UpdateAdminAccountRoleInput,
): Promise<UpdateAdminAccountRoleResult> => {
  if (!canAssignRole(actorRole, role)) {
    throw new AdminRoleAssignmentError();
  }

  const manageableRoles = getManageableRoles(actorRole);

  const account = await deps.prisma.$transaction(async (tx) => {
    const existingAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });

    if (!existingAccount) {
      throw new AdminAccountNotFoundError();
    }

    if (existingAccount.id === actorUserId || !canManageRole(actorRole, existingAccount.role)) {
      throw new AdminRoleHierarchyError();
    }

    if (existingAccount.role === role) {
      throw new AdminRoleAlreadyAssignedError();
    }

    const updated = await tx.user.updateMany({
      where: {
        id: targetUserId,
        role: { in: manageableRoles },
      },
      data: {
        role,
      },
    });

    if (updated.count !== 1) {
      const currentAccount = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, role: true },
      });

      if (!currentAccount) {
        throw new AdminAccountNotFoundError();
      }

      if (currentAccount.id === actorUserId || !canManageRole(actorRole, currentAccount.role)) {
        throw new AdminRoleHierarchyError();
      }

      if (currentAccount.role === role) {
        throw new AdminRoleAlreadyAssignedError();
      }

      throw new Error(`Account role could not be updated for account ${targetUserId}`);
    }

    const updatedAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: updatedAccountRoleSelect,
    });

    if (!updatedAccount) {
      throw new AdminAccountNotFoundError();
    }

    return updatedAccount;
  });

  return {
    message: UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
    account,
  };
};
