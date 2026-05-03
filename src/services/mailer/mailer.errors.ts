export class MailerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailerConfigurationError';
  }
}

export class MailerDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MailerDeliveryError';
  }
}
