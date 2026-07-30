import { describe, expect, test } from 'bun:test';
import {
  createMailerService,
  createSmtpTransportOptions,
} from '../src/services/mailer/mailer.service.js';
import {
  MailerConfigurationError,
  MailerDeliveryError,
} from '../src/services/mailer/mailer.errors.js';
import type { MailerConfig } from '../src/services/mailer/mailer.types.js';
import { OperationTimeoutError } from '../src/lib/operationMetrics.js';
import { createOperationLogCollector } from './support/logCollector.js';

const mailerConfig: MailerConfig = {
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpTlsMode: 'starttls',
  smtpUser: 'user@example.com',
  smtpPass: 'secret',
  smtpFrom: 'no-reply@example.com',
  operationTimeoutMs: 10_000,
};

type SentMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

describe('mailer service', () => {
  test('maps explicit SMTP TLS modes to Nodemailer transport options', () => {
    expect(createSmtpTransportOptions(mailerConfig)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      auth: {
        user: 'user@example.com',
        pass: 'secret',
      },
    });

    expect(
      createSmtpTransportOptions({
        ...mailerConfig,
        smtpPort: 465,
        smtpTlsMode: 'implicit',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      auth: {
        user: 'user@example.com',
        pass: 'secret',
      },
    });

    expect(
      createSmtpTransportOptions({
        ...mailerConfig,
        smtpPort: 1025,
        smtpTlsMode: 'none',
      }),
    ).toEqual({
      host: 'smtp.example.com',
      port: 1025,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      auth: {
        user: 'user@example.com',
        pass: 'secret',
      },
    });
  });

  test('sends verification emails through the configured transporter', async () => {
    const { logger, logs } = createOperationLogCollector();
    const sentEmails: unknown[] = [];
    let transporterCreations = 0;

    const service = createMailerService({
      config: mailerConfig,
      logger,
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
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      level: 'info',
      message: 'SMTP email delivery completed',
      data: {
        operation: 'smtp.sendMail',
        outcome: 'success',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpTlsMode: 'starttls',
        subject: 'Verify your email',
        template: 'verification',
        timeoutMs: 10_000,
      },
    });
    expect(JSON.stringify(logs)).not.toContain('user@example.com');
    expect(JSON.stringify(logs)).not.toContain('123456');
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

    await service.sendPasswordResetEmail('user@example.com', '789012');

    const email = sentEmails.at(0) as SentMail | undefined;

    expect(email).toBeDefined();
    expect(email?.subject).toBe('Reset your password');
    expect(email?.text).toContain('Code: 789012');
    expect(email?.text).toContain('This code expires in 15 minutes.');
    expect(email?.html).toContain('789012');
    expect(email?.html).toContain('This code expires in 15 minutes.');
    expect(email?.text).not.toContain('/reset-password');
    expect(email?.html).not.toContain('/reset-password');
  });

  test('sends account ban notification emails with the admin reason', async () => {
    const { logger, logs } = createOperationLogCollector();
    const sentEmails: unknown[] = [];
    const service = createMailerService({
      config: mailerConfig,
      logger,
      createTransporter: () => ({
        sendMail: async (email: unknown) => {
          sentEmails.push(email);
        },
      }),
    });

    await service.sendAccountBannedEmail(
      'banned@example.com',
      'Repeated abuse <script>alert("x")</script>',
    );

    const email = sentEmails.at(0) as SentMail | undefined;

    expect(email).toBeDefined();
    expect(email?.to).toBe('banned@example.com');
    expect(email?.subject).toBe('Your FairPlay account has been banned');
    expect(email?.text).toContain('Reason provided by the administrator:');
    expect(email?.text).toContain('Repeated abuse <script>alert("x")</script>');
    expect(email?.html).toContain('Reason provided by the administrator');
    expect(email?.html).toContain(
      'Repeated abuse &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(logs[0]).toMatchObject({
      level: 'info',
      message: 'SMTP email delivery completed',
      data: {
        subject: 'Your FairPlay account has been banned',
        template: 'account-ban',
      },
    });
    expect(JSON.stringify(logs)).not.toContain('Repeated abuse');
  });

  test('sends video rejection emails with the title, reason, and retention delay', async () => {
    const { logger, logs } = createOperationLogCollector();
    const sentEmails: unknown[] = [];
    const service = createMailerService({
      config: mailerConfig,
      logger,
      createTransporter: () => ({
        sendMail: async (email: unknown) => {
          sentEmails.push(email);
        },
      }),
    });

    await service.sendVideoRejectedEmail(
      'creator@example.com',
      'Launch recap <script>',
      'Misleading title <script>alert("x")</script>',
    );

    const email = sentEmails.at(0) as SentMail | undefined;

    expect(email).toBeDefined();
    expect(email?.to).toBe('creator@example.com');
    expect(email?.subject).toBe('Your FairPlay video was rejected');
    expect(email?.text).toContain('Launch recap <script>');
    expect(email?.text).toContain('Reason provided by the moderation team:');
    expect(email?.text).toContain('Misleading title <script>alert("x")</script>');
    expect(email?.text).toContain('available by direct link for 7 days');
    expect(email?.text).toContain('permanently deleted automatically');
    expect(email?.html).toContain('Launch recap &lt;script&gt;');
    expect(email?.html).toContain(
      'Misleading title &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(email?.html).toContain('available by direct link for 7 days');
    expect(logs[0]).toMatchObject({
      level: 'info',
      message: 'SMTP email delivery completed',
      data: {
        subject: 'Your FairPlay video was rejected',
        template: 'video-rejection',
      },
    });
    expect(JSON.stringify(logs)).not.toContain('Misleading title');
    expect(JSON.stringify(logs)).not.toContain('Launch recap');
  });

  test('fails clearly when mailer configuration is missing', async () => {
    const service = createMailerService({ config: null });

    await expect(
      service.sendVerificationEmail('user@example.com', '123456'),
    ).rejects.toBeInstanceOf(MailerConfigurationError);
  });

  test('wraps transporter failures as delivery errors', async () => {
    const { logger, logs } = createOperationLogCollector();
    const service = createMailerService({
      config: mailerConfig,
      logger,
      createTransporter: () => ({
        sendMail: async () => {
          throw new Error('SMTP down');
        },
      }),
    });

    await expect(
      service.sendVerificationEmail('user@example.com', '123456'),
    ).rejects.toBeInstanceOf(MailerDeliveryError);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      message: 'SMTP email delivery failed',
      data: {
        operation: 'smtp.sendMail',
        outcome: 'failure',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpTlsMode: 'starttls',
        subject: 'Verify your email',
        template: 'verification',
        timeoutMs: 10_000,
      },
    });
    expect(logs[0]?.data.err).toBeInstanceOf(Error);
  });

  test('times out slow SMTP deliveries with an explicit delivery error cause', async () => {
    let closeCalls = 0;
    let transporterCreations = 0;
    const service = createMailerService({
      config: { ...mailerConfig, operationTimeoutMs: 1 },
      createTransporter: () => {
        transporterCreations += 1;

        return {
          close: () => {
            closeCalls += 1;
          },
          sendMail:
            transporterCreations === 1
              ? () => new Promise((resolve) => setTimeout(resolve, 50))
              : async () => undefined,
        };
      },
    });

    try {
      await service.sendVerificationEmail('user@example.com', '123456');
      throw new Error('Expected sendVerificationEmail to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(MailerDeliveryError);
      expect((err as Error).cause).toBeInstanceOf(OperationTimeoutError);
    }

    expect(closeCalls).toBe(1);
    expect(transporterCreations).toBe(1);

    await service.sendVerificationEmail('user@example.com', '123456');

    expect(closeCalls).toBe(1);
    expect(transporterCreations).toBe(2);
  });
});
