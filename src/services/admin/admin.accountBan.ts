import type { Prisma } from '@prisma/client';
import { BAN_REASON_MAX_LENGTH } from '../../config/constants.js';
import { AUTH_ROLES, type AuthRole } from '../auth.roles.js';
import {
  AdminAccountAlreadyBannedError,
  AdminAccountNotFoundError,
  AdminBanReasonInvalidError,
  AdminRoleHierarchyError,
  AdminSelfBanError,
  ADMIN_BAN_REASON_REQUIRED_MESSAGE,
  ADMIN_BAN_REASON_TOO_LONG_MESSAGE,
} from '../admin.errors.js';
import { handleExpectedMailerError } from '../mailer/mailer.helpers.js';
import type { AdminDependencies } from './admin.dependencies.js';
import { BAN_ACCOUNT_SUCCESS_MESSAGE } from './admin.messages.js';
import type {
  BanAdminAccountInput,
  BanAdminAccountResult,
  BannedAdminAccount,
} from './types/accounts.types.js';

const bannedAccountSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  role: true,
  isBanned: true,
  bannedAt: true,
  banReason: true,
} satisfies Prisma.UserSelect;

type BannedAccountRecord = Prisma.UserGetPayload<{ select: typeof bannedAccountSelect }>;

const ROLE_RANK = {
  user: 0,
  moderator: 1,
  admin: 2,
} satisfies Record<AuthRole, number>;

const canBanRole = (actorRole: AuthRole, targetRole: AuthRole): boolean =>
  ROLE_RANK[actorRole] > ROLE_RANK[targetRole];

const getBannableRoles = (actorRole: AuthRole): AuthRole[] =>
  AUTH_ROLES.filter((targetRole) => canBanRole(actorRole, targetRole));

const normalizeBanReason = (reason: string): string => {
  const normalizedReason = reason.trim();

  if (!normalizedReason) {
    throw new AdminBanReasonInvalidError(ADMIN_BAN_REASON_REQUIRED_MESSAGE);
  }

  if (normalizedReason.length > BAN_REASON_MAX_LENGTH) {
    throw new AdminBanReasonInvalidError(ADMIN_BAN_REASON_TOO_LONG_MESSAGE);
  }

  return normalizedReason;
};

const toBannedAdminAccount = (account: BannedAccountRecord): BannedAdminAccount => {
  if (!account.bannedAt || !account.banReason || !account.isBanned) {
    throw new Error(`Ban state was not persisted for account ${account.id}`);
  }

  return {
    ...account,
    isBanned: true,
    bannedAt: account.bannedAt,
    banReason: account.banReason,
  };
};

export const banAdminAccount = async (
  deps: AdminDependencies,
  { actorRole, actorUserId, reason, targetUserId }: BanAdminAccountInput,
): Promise<BanAdminAccountResult> => {
  if (actorUserId === targetUserId) {
    throw new AdminSelfBanError();
  }

  const normalizedReason = normalizeBanReason(reason);
  const bannableRoles = getBannableRoles(actorRole);
  const bannedAt = deps.clock.now();

  const { account, sessionsRevoked } = await deps.prisma.$transaction(async (tx) => {
    const existingAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, isBanned: true, role: true },
    });

    if (!existingAccount) {
      throw new AdminAccountNotFoundError();
    }

    if (existingAccount.isBanned) {
      throw new AdminAccountAlreadyBannedError();
    }

    if (!canBanRole(actorRole, existingAccount.role)) {
      throw new AdminRoleHierarchyError();
    }

    const updated = await tx.user.updateMany({
      where: {
        id: targetUserId,
        isBanned: false,
        role: { in: bannableRoles },
      },
      data: {
        isBanned: true,
        bannedAt,
        banReason: normalizedReason,
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

      if (currentAccount.isBanned) {
        throw new AdminAccountAlreadyBannedError();
      }

      if (!canBanRole(actorRole, currentAccount.role)) {
        throw new AdminRoleHierarchyError();
      }

      throw new Error(`Account ban could not be applied for account ${targetUserId}`);
    }

    const bannedAccount = await tx.user.findUnique({
      where: { id: targetUserId },
      select: bannedAccountSelect,
    });

    if (!bannedAccount) {
      throw new AdminAccountNotFoundError();
    }

    const revokedSessions = await tx.session.updateMany({
      where: {
        userId: targetUserId,
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });

    return {
      account: toBannedAdminAccount(bannedAccount),
      sessionsRevoked: revokedSessions.count,
    };
  });

  let notificationEmailSent = true;

  try {
    await deps.mailer.sendAccountBannedEmail(account.email, normalizedReason);
  } catch (err) {
    notificationEmailSent = false;
    await handleExpectedMailerError({
      err,
      logger: deps.logger,
      warningMessage: `Account ban notification email could not be sent for user ${account.id}`,
    });
  }

  return {
    message: BAN_ACCOUNT_SUCCESS_MESSAGE,
    account,
    sessionsRevoked,
    notificationEmailSent,
  };
};
