import type { AuthService, LoginInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { normalizeIdentifier } from './auth.helpers.js';
import {
  InvalidCredentialsError,
  AccountBannedError,
  EmailNotVerifiedError,
} from '../auth.errors.js';
import { LOGIN_SUCCESS_MESSAGE } from './auth.messages.js';
import type { SessionService } from './auth.sessions.js';

const MISSING_USER_PASSWORD = 'missing-user-password';

type LoginService = Pick<AuthService, 'login'>;

export const createLoginService = (
  deps: AuthDependencies,
  sessionService: SessionService,
): LoginService => {
  const missingUserPasswordHash = deps.hasher.hash(MISSING_USER_PASSWORD, deps.config.bcryptRounds);

  void missingUserPasswordHash.catch((err: unknown) => {
    deps.logger.warn({ err }, 'Missing user password hash could not be prepared');
  });

  return {
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
          displayName: true,
          bio: true,
          role: true,
          passwordHash: true,
          isVerified: true,
          isBanned: true,
        },
      });

      const isPasswordValid = await deps.hasher.compare(
        password,
        user?.passwordHash ?? (await missingUserPasswordHash),
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

      const { sessionKey, session } = await sessionService.createSession({
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
          displayName: user.displayName,
          bio: user.bio,
          role: user.role,
        },
        sessionKey,
        session,
      };
    },
  };
};
