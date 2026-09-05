export const AUTH_ROLES = ['user', 'moderator', 'admin'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export const ADMIN_ONLY_ROLES = ['admin'] as const satisfies readonly AuthRole[];
export const MODERATION_ROLES = ['moderator', 'admin'] as const satisfies readonly AuthRole[];
