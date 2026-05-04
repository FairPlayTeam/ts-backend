export const APP_PRODUCT_NAME = 'FairPlay';
export const APP_API_NAME = `${APP_PRODUCT_NAME} API`;
export const EMAIL_VERIFICATION_PATH = '/verify-email';
export const APP_VERSION = process.env.npm_package_version ?? '1.0.0';

export const EMAIL_MAX_LENGTH = 254;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const HOUR_MS = 1000 * 60 * 60;
export const DAYS_MS = 24 * HOUR_MS;

export const EMAIL_VERIFICATION_TOKEN_TTL_DAYS = 7;
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = EMAIL_VERIFICATION_TOKEN_TTL_DAYS * DAYS_MS;

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;
