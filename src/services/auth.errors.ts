const USER_ALREADY_EXISTS_MESSAGE = 'User already exists';
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';
const ACCOUNT_BANNED_MESSAGE = 'This account has been banned';
export const EMAIL_NOT_VERIFIED_MESSAGE = 'Please verify your email address before logging in.';
const INVALID_EMAIL_VERIFICATION_TOKEN_MESSAGE = 'Invalid or expired verification link.';
const INVALID_PASSWORD_RESET_TOKEN_MESSAGE = 'Invalid or expired password reset link.';
const PASSWORD_RESET_PASSWORD_REUSE_MESSAGE =
  'New password must be different from the current password';

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
