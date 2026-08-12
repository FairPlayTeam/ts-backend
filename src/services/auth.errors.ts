const USER_ALREADY_EXISTS_MESSAGE = 'User already exists';
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';
const ACCOUNT_BANNED_MESSAGE = 'This account has been banned';
export const EMAIL_NOT_VERIFIED_MESSAGE = 'Please verify your email address before logging in.';
const INVALID_EMAIL_VERIFICATION_TOKEN_MESSAGE = 'Invalid or expired verification code.';
const INVALID_PASSWORD_RESET_TOKEN_MESSAGE = 'Invalid or expired password reset code.';
const PASSWORD_RESET_PASSWORD_REUSE_MESSAGE =
  'New password must be different from the current password';
const PASSWORD_RESET_STATE_CHANGED_MESSAGE =
  'Password state changed during reset. Please try again.';
const AUTHENTICATED_USER_NOT_FOUND_MESSAGE = 'Authenticated user could not be found';
export const PROFILE_UPDATE_EMPTY_MESSAGE = 'At least one profile field must be provided';
export const ACCOUNT_DELETION_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Account deletion is temporarily unavailable; please retry';

export class UserAlreadyExistsError extends Error {
  constructor(cause?: unknown) {
    super(USER_ALREADY_EXISTS_MESSAGE, { cause });
    this.name = 'UserAlreadyExistsError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super(INVALID_CREDENTIALS_MESSAGE);
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountBannedError extends Error {
  constructor() {
    super(ACCOUNT_BANNED_MESSAGE);
    this.name = 'AccountBannedError';
  }
}

export class EmailNotVerifiedError extends Error {
  constructor() {
    super(EMAIL_NOT_VERIFIED_MESSAGE);
    this.name = 'EmailNotVerifiedError';
  }
}

export class InvalidEmailVerificationTokenError extends Error {
  constructor() {
    super(INVALID_EMAIL_VERIFICATION_TOKEN_MESSAGE);
    this.name = 'InvalidEmailVerificationTokenError';
  }
}

export class InvalidPasswordResetTokenError extends Error {
  constructor() {
    super(INVALID_PASSWORD_RESET_TOKEN_MESSAGE);
    this.name = 'InvalidPasswordResetTokenError';
  }
}

export class PasswordResetPasswordReuseError extends Error {
  constructor() {
    super(PASSWORD_RESET_PASSWORD_REUSE_MESSAGE);
    this.name = 'PasswordResetPasswordReuseError';
  }
}

export class PasswordResetStateChangedError extends Error {
  constructor() {
    super(PASSWORD_RESET_STATE_CHANGED_MESSAGE);
    this.name = 'PasswordResetStateChangedError';
  }
}

export class ProfileUpdateEmptyError extends Error {
  constructor() {
    super(PROFILE_UPDATE_EMPTY_MESSAGE);
    this.name = 'ProfileUpdateEmptyError';
  }
}

export class AuthenticatedUserNotFoundError extends Error {
  constructor(cause?: unknown) {
    super(AUTHENTICATED_USER_NOT_FOUND_MESSAGE, { cause });
    this.name = 'AuthenticatedUserNotFoundError';
  }
}

export class AccountDeletionTemporarilyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(ACCOUNT_DELETION_TEMPORARILY_UNAVAILABLE_MESSAGE, { cause });
    this.name = 'AccountDeletionTemporarilyUnavailableError';
  }
}
