import type { Prisma } from '@prisma/client';
import type { AuthRole } from '../auth.roles.js';
import { AdminActorForbiddenError } from '../admin.errors.js';
import { lockUserAuthorizationState } from '../auth/auth.userAuthorization.js';

const isAllowedRole = <AllowedRole extends AuthRole>(
  role: AuthRole,
  allowedRoles: readonly AllowedRole[],
): role is AllowedRole => allowedRoles.some((allowedRole) => allowedRole === role);

export const lockAuthorizedAdminActor = async <AllowedRole extends AuthRole>(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  allowedRoles: readonly AllowedRole[],
): Promise<AllowedRole> => {
  const actor = await lockUserAuthorizationState(tx, actorUserId);

  if (!actor || actor.isBanned || !isAllowedRole(actor.role, allowedRoles)) {
    throw new AdminActorForbiddenError();
  }

  return actor.role;
};
