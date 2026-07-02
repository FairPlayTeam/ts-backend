import type { AuthUser, AuthUserProfile } from './user.types.js';

export type UpdateProfileInput = {
  userId: string;
  displayName?: string | null | undefined;
  bio?: string | null | undefined;
};

export type GetProfileInput = {
  userId: string;
};

export type AuthProfilePort = {
  getProfile: (input: GetProfileInput) => Promise<{ user: AuthUserProfile }>;
  updateProfile: (input: UpdateProfileInput) => Promise<{ message: string; user: AuthUser }>;
};
