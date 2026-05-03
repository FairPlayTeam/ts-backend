import { HttpError } from '../errors/http.js';
import { isPrismaUniqueError } from '../lib/prisma.js';
import { MailerConfigurationError, MailerDeliveryError } from '../services/mailer/mailer.errors.js';

export function toAuthHttpError(err: unknown): Error {
  if (isPrismaUniqueError(err)) {
    return new HttpError(409, 'Conflict', 'User already exists', err);
  }

  if (err instanceof MailerConfigurationError || err instanceof MailerDeliveryError) {
    return new HttpError(503, 'ServiceUnavailable', 'Email delivery failed', err);
  }

  return err instanceof Error ? err : new HttpError(500, 'InternalServerError', 'Unexpected error');
}
