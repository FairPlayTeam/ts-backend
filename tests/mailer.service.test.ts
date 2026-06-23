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

    await service.sendVerificationEmail('user@example.com', '123456');
    await service.sendVerificationEmail('second@example.com', '654321');

    expect(transporterCreations).toBe(1);
    expect(sentEmails).toHaveLength(2);

    const firstEmail = sentEmails.at(0) as SentMail | undefined;

    expect(firstEmail).toBeDefined();
    expect(firstEmail?.from).toBe('"FairPlay" <no-reply@example.com>');
    expect(firstEmail?.to).toBe('user@example.com');
    expect(firstEmail?.subject).toBe('Verify your email');
    expect(firstEmail?.text).toContain('Code: 123456');
    expect(firstEmail?.text).toContain('This code expires in 15 minutes.');
    expect(firstEmail?.html).toContain('123456');
    expect(firstEmail?.html).toContain('This code expires in 15 minutes.');
    expect(firstEmail?.text).not.toContain('/verify-email');
    expect(firstEmail?.html).not.toContain('/verify-email');
  });

  test('sends password reset emails through the configured transporter', async () => {
    const sentEmails: unknown[] = [];
    const service = createMailerService({
      config: mailerConfig,
      createTransporter: () => ({
        sendMail: async (email: unknown) => {
          sentEmails.push(email);
        },
      }),
    });

    await service.sendPasswordResetEmail('user@example.com', 'plain-token');

    const email = sentEmails.at(0) as SentMail | undefined;

    expect(email).toBeDefined();
    expect(email?.subject).toBe('Reset your password');
    expect(email?.text).toContain('http://localhost:5173/reset-password?token=plain-token');
    expect(email?.html).toContain('http://localhost:5173/reset-password?token=plain-token');
  });

  test('fails clearly when mailer configuration is missing', async () => {
    const service = createMailerService({ config: null });

    await expect(
      service.sendVerificationEmail('user@example.com', '123456'),
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
      service.sendVerificationEmail('user@example.com', '123456'),
    ).rejects.toBeInstanceOf(MailerDeliveryError);
  });
});
