import { accountRouteDocs } from './auth/account.routes.js';
import { credentialsRouteDocs } from './auth/credentials.routes.js';
import { mediaRouteDocs } from './auth/media.routes.js';
import { passwordResetRouteDocs } from './auth/passwordReset.routes.js';
import { profileRouteDocs } from './auth/profile.routes.js';
import { sessionRouteDocs } from './auth/sessions.routes.js';
import type { RouteDoc } from './registry.js';

export const routeDocs = [
  ...credentialsRouteDocs,
  ...profileRouteDocs,
  ...accountRouteDocs,
  ...sessionRouteDocs,
  ...mediaRouteDocs,
  ...passwordResetRouteDocs,
] satisfies RouteDoc[];
