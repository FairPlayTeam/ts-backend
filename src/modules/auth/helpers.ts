export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const normalizeIdentifier = (identifier: string): string => identifier.trim().toLowerCase();
export const getSessionKeySuffix = (sessionKey: string): string => sessionKey.slice(-8);
export const getUserScopedAuthCodeSecret = (userId: string, code: string): string =>
  `${userId}:${code}`;

export const getEmailVerificationExpiresAt = (
  now: Date,
  emailVerificationTokenTtlMs: number,
): Date => new Date(now.getTime() + emailVerificationTokenTtlMs);

export const getPasswordResetExpiresAt = (now: Date, passwordResetTokenTtlMs: number): Date =>
  new Date(now.getTime() + passwordResetTokenTtlMs);

export const getSessionExpiresAt = (now: Date, sessionTtlMs: number): Date =>
  new Date(now.getTime() + sessionTtlMs);
