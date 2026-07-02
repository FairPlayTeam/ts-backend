import type { AuthSessionResult } from './sessions.types.js';

export type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

export type LoginInput = {
  emailOrUsername: string;
  password: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

export type AuthCredentialsPort = {
  register: (input: RegisterInput) => Promise<{ message: string }>;
  login: (input: LoginInput) => Promise<AuthSessionResult>;
};
