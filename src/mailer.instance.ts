import appConfig from './config/env.js';
import { createMailerService } from './services/mailer/mailer.service.js';

const mailerService = createMailerService({ config: appConfig.mailer });

export const sendVerificationEmail = (email: string, code: string): Promise<void> =>
  mailerService.sendVerificationEmail(email, code);

export const sendPasswordResetEmail = (email: string, code: string): Promise<void> =>
  mailerService.sendPasswordResetEmail(email, code);
