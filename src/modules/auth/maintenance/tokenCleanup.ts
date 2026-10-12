import type {
  AuthMaintenancePort,
  CleanupExpiredAuthTokensInput,
  CleanupExpiredAuthTokensResult,
} from './types.js';
import type { AuthDependencies } from '../dependencies.js';
import { CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE } from '../messages.js';

type TokenCleanupService = Pick<AuthMaintenancePort, 'cleanupExpiredAuthTokens'>;

export const createTokenCleanupService = (deps: AuthDependencies): TokenCleanupService => ({
  async cleanupExpiredAuthTokens({
    expiredBefore,
  }: CleanupExpiredAuthTokensInput): Promise<CleanupExpiredAuthTokensResult> {
    const [emailVerificationTokens, passwordResetTokens] = await deps.prisma.$transaction([
      deps.prisma.emailVerificationToken.deleteMany({
        where: {
          expiresAt: {
            lt: expiredBefore,
          },
        },
      }),
      deps.prisma.passwordResetToken.deleteMany({
        where: {
          expiresAt: {
            lt: expiredBefore,
          },
        },
      }),
    ]);

    return {
      message: CLEANUP_EXPIRED_AUTH_TOKENS_SUCCESS_MESSAGE,
      emailVerificationTokensDeleted: emailVerificationTokens.count,
      passwordResetTokensDeleted: passwordResetTokens.count,
    };
  },
});
