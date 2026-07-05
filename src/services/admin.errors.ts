import { BAN_REASON_MAX_LENGTH } from '../config/constants.js';

export const ADMIN_ACCOUNT_NOT_FOUND_MESSAGE = 'Account not found';
export const ADMIN_ACCOUNT_ALREADY_BANNED_MESSAGE = 'Account is already banned';
export const ADMIN_SELF_BAN_MESSAGE = 'Administrators cannot ban their own account';
export const ADMIN_ROLE_HIERARCHY_MESSAGE =
  'Cannot ban an account with an equivalent or higher role';
export const ADMIN_BAN_REASON_REQUIRED_MESSAGE = 'Ban reason is required';
export const ADMIN_BAN_REASON_TOO_LONG_MESSAGE = `Ban reason must be at most ${BAN_REASON_MAX_LENGTH} characters`;

export class AdminAccountNotFoundError extends Error {
  constructor() {
    super(ADMIN_ACCOUNT_NOT_FOUND_MESSAGE);
    this.name = 'AdminAccountNotFoundError';
  }
}

export class AdminAccountAlreadyBannedError extends Error {
  constructor() {
    super(ADMIN_ACCOUNT_ALREADY_BANNED_MESSAGE);
    this.name = 'AdminAccountAlreadyBannedError';
  }
}

export class AdminSelfBanError extends Error {
  constructor() {
    super(ADMIN_SELF_BAN_MESSAGE);
    this.name = 'AdminSelfBanError';
  }
}

export class AdminRoleHierarchyError extends Error {
  constructor() {
    super(ADMIN_ROLE_HIERARCHY_MESSAGE);
    this.name = 'AdminRoleHierarchyError';
  }
}

export class AdminBanReasonInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminBanReasonInvalidError';
  }
}
