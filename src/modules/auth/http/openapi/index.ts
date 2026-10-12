import { accountRouteDocs } from './account.routes.js';
import { credentialsRouteDocs } from './credentials.routes.js';
import { mediaRouteDocs } from './media.routes.js';
import { passwordResetRouteDocs } from './passwordReset.routes.js';
import { profileRouteDocs } from './profile.routes.js';
import { sessionRouteDocs } from './sessions.routes.js';
import type { RouteDoc } from '../../../../docs/registry.js';

export const routeDocs = [
  ...credentialsRouteDocs,
  ...profileRouteDocs,
  ...accountRouteDocs,
  ...sessionRouteDocs,
  ...mediaRouteDocs,
  ...passwordResetRouteDocs,
] satisfies RouteDoc[];
