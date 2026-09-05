import { AUTH_ROLES, type AuthRole } from '../auth.roles.js';

const ROLE_RANK = {
  user: 0,
  moderator: 1,
  admin: 2,
} satisfies Record<AuthRole, number>;

export const canManageRole = (actorRole: AuthRole, targetRole: AuthRole): boolean =>
  ROLE_RANK[actorRole] > ROLE_RANK[targetRole];

export const getManageableRoles = (actorRole: AuthRole): AuthRole[] =>
  AUTH_ROLES.filter((targetRole) => canManageRole(actorRole, targetRole));
