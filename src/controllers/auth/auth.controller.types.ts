import type { AuthControllerPort } from '../../services/auth.types.js';

export type AuthControllerDependencies = {
  authService: AuthControllerPort;
};
