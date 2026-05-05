import { describe, expect, test } from 'bun:test';
import { createMailerService } from '../src/services/mailer/mailer.service.js';
import {
  MailerConfigurationError,
  MailerDeliveryError,
} from '../src/services/mailer/mailer.errors.js';
import type { MailerConfig } from '../src/services/mailer/mailer.types.js';

const mailerConfig: MailerConfig = {
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUser: 'user@example.com',
  smtpPass: 'secret',
  smtpFrom: 'no-reply@example.com',
  frontendUrl: 'http://localhost:5173/',
};

type SentMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

describe('mailer service', () => {
  test('sends verification emails through the configured transporter', async () => {
    const sentEmails: unknown[] = [];
    let transporterCreations = 0;

    const service = createMailerService({
      config: mailerConfig,
      createTransporter: (config) => {
        transporterCreations += 1;
        expect(config).toEqual(mailerConfig);

        return {
          sendMail: async (email: unknown) => {
            sentEmails.push(email);
          },
        };
      },
    });

    await service.sendVerificationEmail('user@example.com', 'plain-token');
    await service.sendVerificationEmail('second@example.com', 'second-token');

    expect(transporterCreations).toBe(1);
    expect(sentEmails).toHaveLength(2);

    const firstEmail = sentEmails.at(0) as SentMail | undefined;

    expect(firstEmail).toBeDefined();
    expect(firstEmail?.from).toBe('"FairPlay" <no-reply@example.com>');
    expect(firstEmail?.to).toBe('user@example.com');
    expect(firstEmail?.subject).toBe('Verify your email');
    expect(firstEmail?.text).toContain('http://localhost:5173/verify-email?token=plain-token');
    expect(firstEmail?.html).toContain('http://localhost:5173/verify-email?token=plain-token');
  });

  test('fails clearly when mailer configuration is missing', async () => {
    const service = createMailerService({ config: null });

    await expect(
      service.sendVerificationEmail('user@example.com', 'plain-token'),
    ).rejects.toBeInstanceOf(MailerConfigurationError);
  });

  test('wraps transporter failures as delivery errors', async () => {
    const service = createMailerService({
      config: mailerConfig,
      createTransporter: () => ({
        sendMail: async () => {
          throw new Error('SMTP down');
        },
      }),
    });

    await expect(
      service.sendVerificationEmail('user@example.com', 'plain-token'),
    ).rejects.toBeInstanceOf(MailerDeliveryError);
  });
});
