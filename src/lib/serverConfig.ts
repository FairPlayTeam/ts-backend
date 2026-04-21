export type TrustProxySetting = boolean | number | string | string[];
const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_URLENCODED_BODY_LIMIT_BYTES = 256 * 1024;

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigurationError';
  }
}

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
    return true;
  }

  if (lowerValue === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (value.includes(',')) {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
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

export const parseJsonBodyLimitBytes = (
  rawValue: string | undefined,
): number =>
  parseBodySizeLimitBytes(
    rawValue,
    DEFAULT_JSON_BODY_LIMIT_BYTES,
    'JSON_BODY_LIMIT_BYTES',
  );

export const parseUrlEncodedBodyLimitBytes = (
  rawValue: string | undefined,
): number =>
  parseBodySizeLimitBytes(
    rawValue,
    DEFAULT_URLENCODED_BODY_LIMIT_BYTES,
    'URLENCODED_BODY_LIMIT_BYTES',
  );

export const parseServerPort = (
  rawValue: string | undefined,
  fallback = 3000,
): number => {
  const parsedPort = Number(rawValue ?? fallback);

  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new ServerConfigurationError(
      `PORT must be an integer between 1 and 65535, got: ${rawValue ?? fallback}`,
    );
  }

  return parsedPort;
};

const normalizeUrl = (url: URL): string => url.toString().replace(/\/$/, '');

export const resolveBaseUrl = (
  rawValue: string | undefined,
  port: number,
): string => {
  const value = rawValue?.trim();

  if (!value) {
    return `http://localhost:${port}`;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ServerConfigurationError(
      `BASE_URL must be a valid absolute URL, got: ${value}`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerConfigurationError(
      `BASE_URL must start with http:// or https://, got: ${value}`,
    );
  }

  return normalizeUrl(url);
};

export type MinioClientConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
};

export const parseMinioUrl = (
  rawValue: string | undefined,
): MinioClientConfig => {
  const value = rawValue?.trim();

  if (!value) {
    throw new ServerConfigurationError('MINIO_URL is required');
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ServerConfigurationError(
      `MINIO_URL must be a valid absolute URL, got: ${value}`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ServerConfigurationError(
      `MINIO_URL must start with http:// or https://, got: ${value}`,
    );
  }

  if (!url.hostname) {
    throw new ServerConfigurationError('MINIO_URL must include a hostname');
  }

  if (!url.username || !url.password) {
    throw new ServerConfigurationError(
      'MINIO_URL must include both access key and secret key credentials',
    );
  }

  const port = url.port ? Number(url.port) : 9000;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServerConfigurationError(
      `MINIO_URL must include a valid port when specified, got: ${url.port}`,
    );
  }

  return {
    endPoint: url.hostname,
    port,
    useSSL: url.protocol === 'https:',
    accessKey: decodeURIComponent(url.username),
    secretKey: decodeURIComponent(url.password),
  };
};
