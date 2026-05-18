export class UserAlreadyExistsError extends Error {
  constructor(cause?: unknown) {
    super('User already exists', { cause });
    this.name = 'UserAlreadyExistsError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountBannedError extends Error {
  constructor() {
    super('This account has been banned');
    this.name = 'AccountBannedError';
  }
}

export class EmailNotVerifiedError extends Error {
  constructor() {
    super('Please verify your email address before logging in.');
    this.name = 'EmailNotVerifiedError';
  }
}

export class InvalidEmailVerificationTokenError extends Error {
  constructor() {
    super('Invalid or expired verification link.');
    this.name = 'InvalidEmailVerificationTokenError';
  }
}
