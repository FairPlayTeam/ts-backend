import type { PrismaClient } from '@prisma/client';
import { MailerConfigurationError, MailerDeliveryError } from './mailer/mailer.errors.js';
import { UserAlreadyExistsError } from './auth.errors.js';

type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

type ResendVerificationInput = {
  email: string;
};

type Prisma = Pick<PrismaClient, '$transaction'>;

const REGISTER_SUCCESS_MESSAGE = 'Account created. Please verify your email.';
const RESEND_VERIFICATION_SUCCESS_MESSAGE =
  'If this email exists and is unverified, a new link has been sent.';

type AuthDependencies = {
  isUniqueError(err: unknown): boolean;
  prisma: Prisma;
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
  logger: {
    warn(data: object, message: string): void;
  };
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const getEmailVerificationExpiresAt = (now: Date, emailVerificationTokenTtlMs: number): Date =>
  new Date(now.getTime() + emailVerificationTokenTtlMs);

const isExpectedMailerError = (
  err: unknown,
): err is MailerConfigurationError | MailerDeliveryError =>
  err instanceof MailerConfigurationError || err instanceof MailerDeliveryError;

export const createAuthService = (deps: AuthDependencies) => {
  return {
    async register({ email, username, password }: RegisterInput) {
      const usernameNorm = username.trim().toLowerCase();
      const emailNorm = normalizeEmail(email);

      const hashedPassword = await deps.hasher.hash(password, deps.config.bcryptRounds);

      const token = deps.token.generate();
      const tokenHash = deps.token.hash(token);
      const expiresAt = getEmailVerificationExpiresAt(
        deps.clock.now(),
        deps.config.emailVerificationTokenTtlMs,
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
          if (deps.isUniqueError(err)) {
            throw new UserAlreadyExistsError(err);
          }

          throw err;
        });

      try {
        await deps.mailer.sendVerificationEmail(user.email, token);
      } catch (err) {
        if (isExpectedMailerError(err)) {
          deps.logger.warn({ err }, 'Verification email could not be sent after registration');
        } else {
          throw err;
        }
      }

      return {
        message: REGISTER_SUCCESS_MESSAGE,
      };
    },

    async resendVerification({ email }: ResendVerificationInput) {
      const emailNorm = normalizeEmail(email);
      const token = deps.token.generate();
      const tokenHash = deps.token.hash(token);
      const expiresAt = getEmailVerificationExpiresAt(
        deps.clock.now(),
        deps.config.emailVerificationTokenTtlMs,
      );

      // TRADEOFF: we invalidate the old token before sending the email.
      // If SMTP delivery fails, the user must request another verification email.
      const user = await deps.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({
          where: { email: emailNorm },
          select: { id: true, email: true, isVerified: true },
        });

        if (!existingUser || existingUser.isVerified) {
          return null;
        }

        await tx.emailVerificationToken.upsert({
          where: { userId: existingUser.id },
          update: {
            token: tokenHash,
            expiresAt,
          },
          create: {
            userId: existingUser.id,
            token: tokenHash,
            expiresAt,
          },
        });

        return { email: existingUser.email };
      });

      if (user) {
        try {
          await deps.mailer.sendVerificationEmail(user.email, token);
        } catch (err) {
          if (isExpectedMailerError(err)) {
            deps.logger.warn({ err }, 'Verification email could not be sent after resend request');
          } else {
            throw err;
          }
        }
      }

      return {
        message: RESEND_VERIFICATION_SUCCESS_MESSAGE,
      };
    },
  };
};
