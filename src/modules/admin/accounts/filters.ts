export const ADMIN_ACCOUNT_BAN_STATUSES = ['allUsers', 'banned', 'notbanned'] as const;

export type AdminAccountBanStatus = (typeof ADMIN_ACCOUNT_BAN_STATUSES)[number];

export const DEFAULT_ADMIN_ACCOUNT_BAN_STATUS: AdminAccountBanStatus = 'allUsers';
