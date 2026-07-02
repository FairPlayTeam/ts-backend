import type { AuthAccountPort } from './account.types.js';
import type { AuthCredentialsPort } from './credentials.types.js';
import type { AuthEmailVerificationPort } from './emailVerification.types.js';
import type { AuthMaintenancePort } from './maintenance.types.js';
import type { AuthPasswordResetPort } from './passwordReset.types.js';
import type { AuthProfileMediaPort } from './profileMedia.types.js';
import type { AuthProfilePort } from './profile.types.js';
import type { AuthSessionManagementPort, AuthSessionValidationPort } from './sessions.types.js';

export type AuthControllerPort = AuthCredentialsPort &
  AuthEmailVerificationPort &
  AuthPasswordResetPort &
  AuthProfilePort &
  AuthSessionManagementPort &
  AuthProfileMediaPort &
  AuthAccountPort;

export type AuthRoutePort = AuthControllerPort & AuthSessionValidationPort;

export type AuthPorts = AuthRoutePort & AuthMaintenancePort;
