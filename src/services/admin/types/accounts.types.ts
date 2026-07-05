import type { AuthRole } from '../../auth.roles.js';

export type ListAdminAccountsInput = {
  cursor?: {
    createdAt: Date;
    id: string;
  };
  limit?: number;
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
  actorRole: AuthRole;
  targetUserId: string;
  reason: string;
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

export type AdminAccountsPort = {
  listAccounts: (input: ListAdminAccountsInput) => Promise<ListAdminAccountsResult>;
  banAccount: (input: BanAdminAccountInput) => Promise<BanAdminAccountResult>;
};
