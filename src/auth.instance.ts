import bcrypt from 'bcryptjs';
import config from './config/env.js';
import { isPrismaUniqueError, prisma } from './lib/prisma.js';
import { generateToken, hashToken } from './lib/crypto.js';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  SESSION_TTL_MS,
} from './config/constants.js';
import { sendVerificationEmail, sendPasswordResetEmail } from './mailer.instance.js';
import { logger } from './lib/logger.js';
import { createAuthService } from './services/auth.service.js';
import { objectStorage } from './objectStorage.instance.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { createUserMediaProcessor } from './services/userMedia/userMedia.processor.js';

const bcryptHasher = {
  hash: (password: string, rounds: number) => bcrypt.hash(password, rounds),
  compare: (password: string, hash: string) => bcrypt.compare(password, hash),
};

const tokenService = {
  generate: () => generateToken(),
  hash: (token: string) => hashToken(token),
};

const systemClock = {
  now: () => new Date(),
};

export const authService = createAuthService({
  prisma,
  isUniqueError: isPrismaUniqueError,
  hasher: bcryptHasher,
  token: tokenService,
  mailer: { sendVerificationEmail, sendPasswordResetEmail },
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
  userMediaProcessor: createUserMediaProcessor({
    avatarMaxUploadBytes: config.avatarMaxUploadBytes,
  }),
  clock: systemClock,
  config: {
    bcryptRounds: config.bcryptRounds,
    emailVerificationTokenTtlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
    passwordResetTokenTtlMs: PASSWORD_RESET_TOKEN_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
  },
  logger,
});
