import type { Prisma } from '@prisma/client';
import { AccountBannedError, InvalidCredentialsError } from '../errors.js';
import type { AuthDependencies } from '../dependencies.js';
import { lockUserAuthorizationState } from '../authorization.js';

type ReauthenticateSensitiveActionInput = {
  userId: string;
  currentPassword: string;
};

export const reauthenticateSensitiveAction = async (
  deps: AuthDependencies,
  { userId, currentPassword }: ReauthenticateSensitiveActionInput,
): Promise<string> => {
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

  return user.passwordHash;
};

// Call inside the operation's transaction, after its resource locks and before its effects.
// Bcrypt must have authenticated this exact hash before acquiring any database lock.
export const lockAuthenticatedUser = async (
  tx: Prisma.TransactionClient,
  userId: string,
  authenticatedPasswordHash: string,
) => {
  const lockedUser = await lockUserAuthorizationState(tx, userId);
  if (!lockedUser) {
    throw new InvalidCredentialsError();
  }

  const currentUser = await tx.user.findUnique({
    where: { id: userId },
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

  if (!currentUser || currentUser.passwordHash !== authenticatedPasswordHash) {
    throw new InvalidCredentialsError();
  }
  if (currentUser.isBanned) {
    throw new AccountBannedError();
  }

  return {
    id: currentUser.id,
    email: currentUser.email,
    username: currentUser.username,
    displayName: currentUser.displayName,
    bio: currentUser.bio,
    role: currentUser.role,
    isVerified: currentUser.isVerified,
  };
};
