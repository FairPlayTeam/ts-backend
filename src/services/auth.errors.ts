export class UserAlreadyExistsError extends Error {
  constructor(cause?: unknown) {
    super('User already exists', { cause });
    this.name = 'UserAlreadyExistsError';
  }
}

export class VerificationEmailUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Email delivery failed', { cause });
    this.name = 'VerificationEmailUnavailableError';
  }
}
