import { DEFAULT_JSON_BODY_LIMIT_BYTES } from './constants.js';
import type { MailerConfig } from '../services/mailer/mailer.types.js';

export type TrustProxySetting = boolean | number | string | string[];

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigurationError';
  }
}

export const readRequiredEnv = (value: string | undefined, name: string): string => {
  const trimmedValue = value?.trim();

  if (!trimmedValue) {
    throw new ServerConfigurationError(`${name} is required`);
  }

  return trimmedValue;
};

export const parseServerPort = (rawData: string | undefined, fallback = 3000): number => {
  const value = rawData ?? String(fallback);
  const parsedPort = Number(value);

  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new ServerConfigurationError(
      `PORT must be an integer between 1 and 65535, got: ${value}`,
    );
  }

  return parsedPort;
};

export const parseBcryptRounds = (rawData: string | undefined, fallback = 12): number => {
  const value = rawData ?? String(fallback);
  const rounds = Number(value);

  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    throw new ServerConfigurationError(
      `BCRYPT_ROUNDS must be an integer between 4 and 31, got: ${value}`,
    );
  }

  return rounds;
};

export const parseRequiredUrl = (rawData: string | undefined, name: string): string => {
  const value = readRequiredEnv(rawData, name);

  try {
    return new URL(value).toString();
  } catch {
    throw new ServerConfigurationError(`${name} must be a valid URL, got: ${value}`);
  }
};

export const parseTrustProxy = (
  rawValue: string | undefined,
  nodeEnv?: string,
): TrustProxySetting => {
  const value = rawValue?.trim();

  if (!value) {
    if (nodeEnv === 'development') {
      return 'loopback';
    }

    return false;
  }

  const lowerValue = value.toLowerCase();

  if (lowerValue === 'true') {
    throw new ServerConfigurationError(
      'TRUST_PROXY=true is unsafe with IP-based rate limiting. Use false, loopback, a numeric proxy hop count such as 1, or an explicit proxy list.',
    );
  }

  if (lowerValue === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value.includes(',')) {
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return entries.length > 0 ? entries : false;
  }

  return value;
};

export const parseBodySizeLimitBytes = (
  rawValue: string | undefined,
  fallback: number,
  envName: string,
): number => {
  const value = rawValue?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ServerConfigurationError(
      `${envName} must be a positive integer number of bytes, got: ${value}`,
    );
  }

  return parsed;
};

export const parseJsonBodyLimitBytes = (rawValue: string | undefined): number =>
  parseBodySizeLimitBytes(rawValue, DEFAULT_JSON_BODY_LIMIT_BYTES, 'JSON_BODY_LIMIT_BYTES');

export const parseIsProduction = (rawValue: string | undefined): boolean =>
  rawValue === 'production';

export const parseAllowedOrigins = (rawValue: string | undefined): string[] => {
  const value = rawValue?.trim();

  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
        .map((origin) => {
          try {
            return new URL(origin).origin;
          } catch {
            throw new ServerConfigurationError(
              `CORS_ORIGINS entries must be valid origins, got: ${origin}`,
            );
          }
        }),
    ),
  ];
};

export const parseSmtpPort = (rawPort: string | undefined): number => {
  const value = readRequiredEnv(rawPort, 'SMTP_PORT');
  const smtpPort = Number(value);

  if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new ServerConfigurationError(`SMTP_PORT must be a valid port number, got: ${value}`);
  }

  return smtpPort;
};

export const parseFrontendUrl = (rawUrl: string | undefined): string =>
  parseRequiredUrl(rawUrl, 'FRONTEND_URL');

type RawMailerConfig = {
  smtpHost: string | undefined;
  smtpPort: string | undefined;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  smtpFrom: string | undefined;
  frontendUrl: string | undefined;
};

const mailerEnvNames = {
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpUser: 'SMTP_USER',
  smtpPass: 'SMTP_PASS',
  smtpFrom: 'SMTP_FROM',
  frontendUrl: 'FRONTEND_URL',
} as const satisfies Record<keyof RawMailerConfig, string>;

export const parseMailerConfig = (rawConfig: RawMailerConfig): MailerConfig | null => {
  const missingKeys = Object.entries(rawConfig)
    .filter(([, value]) => !value?.trim())
    .map(([key]) => mailerEnvNames[key as keyof RawMailerConfig]);

  if (missingKeys.length === Object.keys(rawConfig).length) {
    return null;
  }

  if (missingKeys.length > 0) {
    throw new ServerConfigurationError(
      `Email delivery configuration is incomplete. Missing environment variables: ${missingKeys.join(', ')}`,
    );
  }

  return {
    smtpHost: readRequiredEnv(rawConfig.smtpHost, 'SMTP_HOST'),
    smtpPort: parseSmtpPort(rawConfig.smtpPort),
    smtpUser: readRequiredEnv(rawConfig.smtpUser, 'SMTP_USER'),
    smtpPass: readRequiredEnv(rawConfig.smtpPass, 'SMTP_PASS'),
    smtpFrom: readRequiredEnv(rawConfig.smtpFrom, 'SMTP_FROM'),
    frontendUrl: parseFrontendUrl(rawConfig.frontendUrl),
  };
};
