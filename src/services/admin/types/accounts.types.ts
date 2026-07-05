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

export type ListAdminAccountsResult = {
  accounts: AdminAccountSummary[];
  total: number;
  nextCursor: {
    createdAt: Date;
    id: string;
  } | null;
};

export type AdminAccountsPort = {
  listAccounts: (input: ListAdminAccountsInput) => Promise<ListAdminAccountsResult>;
};
