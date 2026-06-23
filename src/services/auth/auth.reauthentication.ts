import { AccountBannedError, InvalidCredentialsError } from '../auth.errors.js';
import type { AuthDependencies } from './auth.dependencies.js';

type ReauthenticateSensitiveActionInput = {
  userId: string;
  currentPassword: string;
};

export const reauthenticateSensitiveAction = async (
  deps: AuthDependencies,
  { userId, currentPassword }: ReauthenticateSensitiveActionInput,
): Promise<void> => {
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      isBanned: true,
    },
  });

  if (!user) {
    throw new InvalidCredentialsError();
  }

  const isPasswordValid = await deps.hasher.compare(currentPassword, user.passwordHash);

  if (!isPasswordValid) {
    throw new InvalidCredentialsError();
  }

  if (user.isBanned) {
    throw new AccountBannedError();
  }
};
