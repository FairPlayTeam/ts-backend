import { Prisma } from '@prisma/client';
import type { AuthRole } from '../auth.roles.js';

export type LockedUserAuthorizationState = {
  role: AuthRole;
  isBanned: boolean;
};

export const lockUserAuthorizationState = async (
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<LockedUserAuthorizationState | null> => {
  const [user] = await tx.$queryRaw<Array<LockedUserAuthorizationState>>(
    Prisma.sql`
      SELECT
        "role"::text AS "role",
        "is_banned" AS "isBanned"
      FROM "users"
      WHERE "id" = CAST(${userId} AS UUID)
      FOR UPDATE
    `,
  );

  return user ?? null;
};
