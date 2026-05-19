import type { PrismaClient } from '@prisma/client';
import { MailerConfigurationError, MailerDeliveryError } from './mailer/mailer.errors.js';
import {
  AccountBannedError,
  EmailNotVerifiedError,
  InvalidEmailVerificationTokenError,
  InvalidCredentialsError,
  UserAlreadyExistsError,
} from './auth.errors.js';

type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

type LoginInput = {
  emailOrUsername: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

type ResendVerificationInput = {
  email: string;
};

type VerifyEmailInput = {
  token: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

type AuthenticatedSession = {
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
  };
  session: {
    id: string;
    expiresAt: Date;
  };
};

type ListUserSessionsInput = {
  userId: string;
  currentSessionId: string;
};

type LogoutAllSessionsInput = {
  userId: string;
};

type LogoutOtherSessionsInput = {
  userId: string;
  currentSessionId: string;
};

type UserSessionSummary = {
  id: string;
  sessionKeySuffix: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceInfo: string | null;
  isCurrent: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
};

type Prisma = Pick<PrismaClient, '$transaction' | 'emailVerificationToken' | 'session' | 'user'>;

const REGISTER_SUCCESS_MESSAGE = 'Account created. Please verify your email.';
const LOGIN_SUCCESS_MESSAGE = 'Login successful';
const VERIFY_EMAIL_SUCCESS_MESSAGE = 'Email successfully verified';
const RESEND_VERIFICATION_SUCCESS_MESSAGE =
  'If this email exists and is unverified, a new link has been sent.';
const LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE = 'All sessions logged out successfully';
const LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE = 'Other sessions logged out successfully';
const MISSING_USER_PASSWORD_HASH = '$2b$12$7g84a6zb7kmHybVdMfIeEuIPU7Lvt5SbjKaX5xIUgQdQwut8EMhNe';

type AuthDependencies = {
  isUniqueError(err: unknown): boolean;
  prisma: Prisma;
  hasher: {
    hash(password: string, rounds: number): Promise<string>;
    compare(password: string, hash: string): Promise<boolean>;
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
    sessionTtlMs: number;
  };
  logger: {
    warn(data: object, message: string): void;
  };
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const normalizeIdentifier = (identifier: string): string => identifier.trim().toLowerCase();
const getSessionKeySuffix = (sessionKey: string): string => sessionKey.slice(-8);

const getEmailVerificationExpiresAt = (now: Date, emailVerificationTokenTtlMs: number): Date =>
  new Date(now.getTime() + emailVerificationTokenTtlMs);

const getSessionExpiresAt = (now: Date, sessionTtlMs: number): Date =>
  new Date(now.getTime() + sessionTtlMs);

const isExpectedMailerError = (
  err: unknown,
): err is MailerConfigurationError | MailerDeliveryError =>
  err instanceof MailerConfigurationError || err instanceof MailerDeliveryError;

export const createAuthService = (deps: AuthDependencies) => {
  const prepareSession = ({
    ipAddress,
    userAgent,
  }: {
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }) => {
    const now = deps.clock.now();
    const expiresAt = getSessionExpiresAt(now, deps.config.sessionTtlMs);
    const sessionKey = deps.token.generate();
    const sessionKeyHash = deps.token.hash(sessionKey);

    return {
      now,
      sessionKey,
      sessionData: {
        sessionKey: sessionKeyHash,
        sessionKeySuffix: getSessionKeySuffix(sessionKey),
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        deviceInfo: userAgent ?? null,
        expiresAt,
      },
    };
  };

  const createSession = async ({
    userId,
    ipAddress,
    userAgent,
  }: {
    userId: string;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }) => {
    const { now, sessionKey, sessionData } = prepareSession({ ipAddress, userAgent });

    const session = await deps.prisma.$transaction(async (tx) => {
      const createdSession = await tx.session.create({
        data: {
          ...sessionData,
          userId,
        },
        select: {
          id: true,
          expiresAt: true,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { lastLogin: now },
      });

      return createdSession;
    });

    return { sessionKey, session };
  };

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

    async login({ emailOrUsername, password, ipAddress, userAgent }: LoginInput) {
      const lookup = normalizeIdentifier(emailOrUsername);

      const user = await deps.prisma.user.findFirst({
        where: {
          OR: [{ email: lookup }, { username: lookup }],
        },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          passwordHash: true,
          isVerified: true,
          isBanned: true,
        },
      });

      const isPasswordValid = await deps.hasher.compare(
        password,
        user?.passwordHash ?? MISSING_USER_PASSWORD_HASH,
      );

      if (!user || !isPasswordValid) {
        throw new InvalidCredentialsError();
      }

      if (user.isBanned) {
        throw new AccountBannedError();
      }

      if (!user.isVerified) {
        throw new EmailNotVerifiedError();
      }

      const { sessionKey, session } = await createSession({
        userId: user.id,
        ipAddress,
        userAgent,
      });

      return {
        message: LOGIN_SUCCESS_MESSAGE,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        },
        sessionKey,
        session,
      };
    },

    async verifyEmail({ token, ipAddress, userAgent }: VerifyEmailInput) {
      const tokenHash = deps.token.hash(token);
      const { now, sessionKey, sessionData } = prepareSession({ ipAddress, userAgent });

      const record = await deps.prisma.emailVerificationToken.findUnique({
        where: { token: tokenHash },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              role: true,
              isBanned: true,
            },
          },
        },
      });

      if (!record) {
        throw new InvalidEmailVerificationTokenError();
      }

      if (record.expiresAt <= now) {
        await deps.prisma.emailVerificationToken.deleteMany({ where: { token: tokenHash } });
        throw new InvalidEmailVerificationTokenError();
      }

      if (record.user.isBanned) {
        throw new AccountBannedError();
      }

      const session = await deps.prisma.$transaction(async (tx) => {
        const consumedToken = await tx.emailVerificationToken.deleteMany({
          where: { token: tokenHash },
        });

        if (consumedToken.count !== 1) {
          throw new InvalidEmailVerificationTokenError();
        }

        await tx.user.update({
          where: { id: record.userId },
          data: { isVerified: true, lastLogin: now },
        });

        return tx.session.create({
          data: {
            ...sessionData,
            userId: record.userId,
          },
          select: {
            id: true,
            expiresAt: true,
          },
        });
      });

      return {
        message: VERIFY_EMAIL_SUCCESS_MESSAGE,
        user: {
          id: record.user.id,
          email: record.user.email,
          username: record.user.username,
          role: record.user.role,
        },
        sessionKey,
        session,
      };
    },

    async validateSession(sessionKey: string): Promise<AuthenticatedSession | null> {
      const sessionKeyHash = deps.token.hash(sessionKey);
      const now = deps.clock.now();

      const session = await deps.prisma.session.findUnique({
        where: { sessionKey: sessionKeyHash },
        select: {
          id: true,
          expiresAt: true,
          isActive: true,
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              role: true,
              isBanned: true,
            },
          },
        },
      });

      if (!session || !session.isActive || session.expiresAt <= now || session.user.isBanned) {
        return null;
      }

      await deps.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: now },
        select: { id: true },
      });

      return {
        user: {
          id: session.user.id,
          email: session.user.email,
          username: session.user.username,
          role: session.user.role,
        },
        session: {
          id: session.id,
          expiresAt: session.expiresAt,
        },
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

    async getUserSessions({
      userId,
      currentSessionId,
    }: ListUserSessionsInput): Promise<{ sessions: UserSessionSummary[]; total: number }> {
      const now = deps.clock.now();

      const sessions = await deps.prisma.session.findMany({
        where: {
          userId,
          isActive: true,
          expiresAt: {
            gt: now,
          },
        },
        select: {
          id: true,
          sessionKeySuffix: true,
          ipAddress: true,
          userAgent: true,
          deviceInfo: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
        },
        orderBy: {
          lastUsedAt: 'desc',
        },
      });

      return {
        sessions: sessions.map((session) => ({
          id: session.id,
          sessionKeySuffix: session.sessionKeySuffix,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          deviceInfo: session.deviceInfo,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          expiresAt: session.expiresAt,
          isCurrent: session.id === currentSessionId,
        })),
        total: sessions.length,
      };
    },

    async logoutAllSessions({
      userId,
    }: LogoutAllSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const result = await deps.prisma.session.updateMany({
        where: {
          userId,
          isActive: true,
        },
        data: {
          isActive: false,
        },
      });

      return {
        message: LOGOUT_ALL_SESSIONS_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },

    async logoutOtherSessions({
      userId,
      currentSessionId,
    }: LogoutOtherSessionsInput): Promise<{ message: string; sessionsLoggedOut: number }> {
      const result = await deps.prisma.session.updateMany({
        where: {
          userId,
          isActive: true,
          id: {
            not: currentSessionId,
          },
        },
        data: {
          isActive: false,
        },
      });

      return {
        message: LOGOUT_OTHER_SESSIONS_SUCCESS_MESSAGE,
        sessionsLoggedOut: result.count,
      };
    },
  };
};
