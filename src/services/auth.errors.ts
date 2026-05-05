export class UserAlreadyExistsError extends Error {
  constructor(cause?: unknown) {
    super('User already exists', { cause });
    this.name = 'UserAlreadyExistsError';
  }
}
