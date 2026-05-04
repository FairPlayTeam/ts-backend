import { prisma } from '../lib/prisma.js';
import bcrypt from 'bcryptjs';
import config from '../config/env.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from '../config/constants.js';
import { sendVerificationEmail } from './mailer/mailer.service.js';
import { isPrismaUniqueError } from '../lib/prisma.js';
import { MailerConfigurationError, MailerDeliveryError } from './mailer/mailer.errors.js';
import { UserAlreadyExistsError, VerificationEmailUnavailableError } from './auth.errors.js';

type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

type AuthDependencies = {
  prisma: Pick<typeof prisma, '$transaction' | 'user'>;
  hasher: {
    hash(password: string, rounds: number): Promise<string>;
  };
  token: {
    generate(): string;
    hash(token: string): string;
  };
  mailer: {
    sendVerificationEmail(email: string, token: string): Promise<void>;
  };
  clock: {
    now(): Date;
  };
  config: {
    bcryptRounds: number;
    emailVerificationTokenTtlMs: number;
  };
};

export const createAuthService = (deps: AuthDependencies) => {
  return {
    async register({ email, username, password }: RegisterInput) {
      const usernameNorm = username.trim().toLowerCase();
      const emailNorm = email.trim().toLowerCase();

      const hashedPassword = await deps.hasher.hash(password, deps.config.bcryptRounds);

      const token = deps.token.generate();
      const tokenHash = deps.token.hash(token);
      const expiresAt = new Date(
        deps.clock.now().getTime() + deps.config.emailVerificationTokenTtlMs,
      );

      const user = await deps.prisma
        .$transaction(async (tx) => {
          const createdUser = await tx.user.create({
            data: {
              email: emailNorm,
              username: usernameNorm,
              passwordHash: hashedPassword,
            },
            select: { id: true, email: true, username: true, role: true },
          });

          await tx.emailVerificationToken.create({
            data: {
              userId: createdUser.id,
              token: tokenHash,
              expiresAt,
            },
          });

          return createdUser;
        })
        .catch((err) => {
          if (isPrismaUniqueError(err)) {
            throw new UserAlreadyExistsError(err);
          }

          throw err;
        });

      try {
        await deps.mailer.sendVerificationEmail(user.email, token);
      } catch (err) {
        await deps.prisma.user.delete({ where: { id: user.id } }).catch((cleanupError) => {
          console.error('Failed to roll back user after verification email failure:', cleanupError);
        });
        if (err instanceof MailerConfigurationError || err instanceof MailerDeliveryError) {
          throw new VerificationEmailUnavailableError(err);
        }

        throw err;
      }

      return {
        message: 'Account created. Please verify your email.',
      };
    },
  };
};

const bcryptHasher = {
  hash: (password: string, rounds: number) => bcrypt.hash(password, rounds),
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
  hasher: bcryptHasher,
  token: tokenService,
  mailer: { sendVerificationEmail },
  clock: systemClock,
  config: {
    bcryptRounds: config.bcryptRounds,
    emailVerificationTokenTtlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
  },
});
