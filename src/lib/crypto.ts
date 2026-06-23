import crypto from 'crypto';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateSixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}
