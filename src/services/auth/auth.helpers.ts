import { MailerConfigurationError, MailerDeliveryError } from '../mailer/mailer.errors.js';

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const normalizeIdentifier = (identifier: string): string => identifier.trim().toLowerCase();
export const getSessionKeySuffix = (sessionKey: string): string => sessionKey.slice(-8);
export const getEmailVerificationCodeSecret = (userId: string, code: string): string =>
  `${userId}:${code}`;

export const getEmailVerificationExpiresAt = (
  now: Date,
  emailVerificationTokenTtlMs: number,
): Date => new Date(now.getTime() + emailVerificationTokenTtlMs);

export const getPasswordResetExpiresAt = (now: Date, passwordResetTokenTtlMs: number): Date =>
  new Date(now.getTime() + passwordResetTokenTtlMs);

export const getSessionExpiresAt = (now: Date, sessionTtlMs: number): Date =>
  new Date(now.getTime() + sessionTtlMs);

const isExpectedMailerError = (
  err: unknown,
): err is MailerConfigurationError | MailerDeliveryError =>
  err instanceof MailerConfigurationError || err instanceof MailerDeliveryError;

type ExpectedMailerErrorHandlerOptions = {
  err: unknown;
  logger: {
    warn(data: object, message: string): void;
  };
  warningMessage: string;
  cleanup?: {
    run(): Promise<unknown>;
    warningMessage: string;
  };
};

export const handleExpectedMailerError = async ({
  err,
  logger,
  warningMessage,
  cleanup,
}: ExpectedMailerErrorHandlerOptions): Promise<void> => {
  if (!isExpectedMailerError(err)) {
    throw err;
  }

  logger.warn({ err }, warningMessage);

  if (!cleanup) {
    return;
  }

  await cleanup.run().catch((cleanupError: unknown) => {
    logger.warn({ cleanupError }, cleanup.warningMessage);
  });
};
