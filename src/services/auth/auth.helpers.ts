import { MailerConfigurationError, MailerDeliveryError } from '../mailer/mailer.errors.js';

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const normalizeIdentifier = (identifier: string): string => identifier.trim().toLowerCase();
export const getSessionKeySuffix = (sessionKey: string): string => sessionKey.slice(-8);

export const getEmailVerificationExpiresAt = (
  now: Date,
  emailVerificationTokenTtlMs: number,
): Date => new Date(now.getTime() + emailVerificationTokenTtlMs);

export const getSessionExpiresAt = (now: Date, sessionTtlMs: number): Date =>
  new Date(now.getTime() + sessionTtlMs);

export const isExpectedMailerError = (
  err: unknown,
): err is MailerConfigurationError | MailerDeliveryError =>
  err instanceof MailerConfigurationError || err instanceof MailerDeliveryError;
