import appConfig from './config/env.js';
import { logger } from './lib/logger.js';
import { createMailerService } from './services/mailer/mailer.service.js';

const mailerService = createMailerService({ config: appConfig.mailer, logger });

export const sendVerificationEmail = (email: string, code: string): Promise<void> =>
  mailerService.sendVerificationEmail(email, code);

export const sendPasswordResetEmail = (email: string, code: string): Promise<void> =>
  mailerService.sendPasswordResetEmail(email, code);

export const sendAccountBannedEmail = (email: string, reason: string): Promise<void> =>
  mailerService.sendAccountBannedEmail(email, reason);

export const sendVideoRejectedEmail = (
  email: string,
  title: string,
  reason: string,
): Promise<void> => mailerService.sendVideoRejectedEmail(email, title, reason);
