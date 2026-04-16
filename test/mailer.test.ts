import { describe, expect, it } from 'bun:test';
import {
  assertMailerConfigured,
  MailerConfigurationError,
} from '../src/lib/mailer.js';

const MAILER_ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'FRONTEND_URL',
] as const;

type MailerEnvKey = (typeof MAILER_ENV_KEYS)[number];

const snapshotMailerEnv = (): Record<MailerEnvKey, string | undefined> =>
  Object.fromEntries(
    MAILER_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<MailerEnvKey, string | undefined>;

const restoreMailerEnv = (
  snapshot: Record<MailerEnvKey, string | undefined>,
): void => {
  for (const key of MAILER_ENV_KEYS) {
    const value = snapshot[key];

    if (typeof value === 'undefined') {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
};

describe('assertMailerConfigured', () => {
  it('rejects missing SMTP configuration', () => {
    const snapshot = snapshotMailerEnv();

    for (const key of MAILER_ENV_KEYS) {
      delete process.env[key];
    }

    expect(() => assertMailerConfigured()).toThrow(MailerConfigurationError);

    restoreMailerEnv(snapshot);
  });

  it('accepts a complete verification-email configuration', () => {
    const snapshot = snapshotMailerEnv();

    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-password';
    process.env.SMTP_FROM = 'noreply@example.com';
    process.env.FRONTEND_URL = 'https://app.example.com';

    expect(() => assertMailerConfigured()).not.toThrow();

    restoreMailerEnv(snapshot);
  });
});
