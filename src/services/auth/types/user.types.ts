import type { AuthRole } from '../../auth.roles.js';

export type { AuthRole } from '../../auth.roles.js';

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  role: AuthRole;
};

export type AuthUserProfile = AuthUser & {
  avatarUrl: string | null;
  bannerUrl: string | null;
};
