import appConfig from './config/env.js';
import { createMailerService } from './services/mailer/mailer.service.js';

export const mailerService = createMailerService({ config: appConfig.mailer });

export const sendVerificationEmail = (email: string, token: string): Promise<void> =>
  mailerService.sendVerificationEmail(email, token);
