export const AUTH_ROLES = ['user', 'moderator', 'admin'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];
