import { BAN_REASON_MAX_LENGTH } from '../config/constants.js';

export const ADMIN_ACCOUNT_NOT_FOUND_MESSAGE = 'Account not found';
export const ADMIN_ACCOUNT_ALREADY_BANNED_MESSAGE = 'Account is already banned';
export const ADMIN_ACCOUNT_NOT_BANNED_MESSAGE = 'Account is not banned';
export const ADMIN_SELF_BAN_MESSAGE = 'Administrators cannot ban their own account';
export const ADMIN_SELF_UNBAN_MESSAGE = 'Administrators cannot unban their own account';
export const ADMIN_ROLE_HIERARCHY_MESSAGE =
  'Cannot manage an account with an equivalent or higher role';
export const ADMIN_ROLE_ASSIGNMENT_MESSAGE = 'Cannot assign a role higher than your own';
export const ADMIN_ROLE_ALREADY_ASSIGNED_MESSAGE = 'Account already has this role';
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

export class AdminAccountNotBannedError extends Error {
  constructor() {
    super(ADMIN_ACCOUNT_NOT_BANNED_MESSAGE);
    this.name = 'AdminAccountNotBannedError';
  }
}

export class AdminSelfBanError extends Error {
  constructor() {
    super(ADMIN_SELF_BAN_MESSAGE);
    this.name = 'AdminSelfBanError';
  }
}

export class AdminSelfUnbanError extends Error {
  constructor() {
    super(ADMIN_SELF_UNBAN_MESSAGE);
    this.name = 'AdminSelfUnbanError';
  }
}

export class AdminRoleHierarchyError extends Error {
  constructor() {
    super(ADMIN_ROLE_HIERARCHY_MESSAGE);
    this.name = 'AdminRoleHierarchyError';
  }
}

export class AdminRoleAssignmentError extends Error {
  constructor() {
    super(ADMIN_ROLE_ASSIGNMENT_MESSAGE);
    this.name = 'AdminRoleAssignmentError';
  }
}

export class AdminRoleAlreadyAssignedError extends Error {
  constructor() {
    super(ADMIN_ROLE_ALREADY_ASSIGNED_MESSAGE);
    this.name = 'AdminRoleAlreadyAssignedError';
  }
}

export class AdminBanReasonInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminBanReasonInvalidError';
  }
}
