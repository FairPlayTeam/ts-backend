import type { AuthRole } from '../../auth.roles.js';
import type { AdminAccountBanStatus } from '../admin.accountFilters.js';

export type ListAdminAccountsInput = {
  actorUserId: string;
  cursor?: {
    createdAt: Date;
    id: string;
  };
  limit?: number;
  search?: string;
  banStatus?: AdminAccountBanStatus;
};

export type AdminAccountSummary = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  isVerified: boolean;
  isBanned: boolean;
  bannedAt: Date | null;
  lastLogin: Date | null;
  updatedAt: Date;
  role: AuthRole;
};

export type BanAdminAccountInput = {
  actorUserId: string;
  targetUserId: string;
  reason: string;
};

export type UnbanAdminAccountInput = {
  actorUserId: string;
  targetUserId: string;
};

export type UpdateAdminAccountRoleInput = {
  actorUserId: string;
  targetUserId: string;
  role: AuthRole;
};

export type BannedAdminAccount = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: AuthRole;
  isBanned: true;
  bannedAt: Date;
  banReason: string;
};

export type UnbannedAdminAccount = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: AuthRole;
  isBanned: false;
  bannedAt: null;
  banReason: null;
};

export type UpdatedAdminAccountRole = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  role: AuthRole;
  updatedAt: Date;
};

export type ListAdminAccountsResult = {
  accounts: AdminAccountSummary[];
  total: number;
  nextCursor: {
    createdAt: Date;
    id: string;
  } | null;
};

export type BanAdminAccountResult = {
  message: string;
  account: BannedAdminAccount;
  sessionsRevoked: number;
  notificationEmailSent: boolean;
};

export type UnbanAdminAccountResult = {
  message: string;
  account: UnbannedAdminAccount;
};

export type UpdateAdminAccountRoleResult = {
  message: string;
  account: UpdatedAdminAccountRole;
};

export type AdminAccountsPort = {
  listAccounts: (input: ListAdminAccountsInput) => Promise<ListAdminAccountsResult>;
  banAccount: (input: BanAdminAccountInput) => Promise<BanAdminAccountResult>;
  unbanAccount: (input: UnbanAdminAccountInput) => Promise<UnbanAdminAccountResult>;
  updateAccountRole: (input: UpdateAdminAccountRoleInput) => Promise<UpdateAdminAccountRoleResult>;
};
