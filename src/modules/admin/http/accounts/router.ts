import { Router, type RequestHandler } from 'express';
import type { AuthSessionValidationPort } from '../../../auth/index.js';
import { createRouteProtector } from '../../../../middleware/routeProtection.js';
import { validate } from '../../../../middleware/validation.js';
import { ADMIN_ONLY_ROLES } from '../../authorization.js';
import type { AdminAccountsPort } from '../../accounts/types.js';
import { createAdminAccountsHandlers } from './handlers.js';
import { routeDocs } from './openapi.js';
import {
  adminAccountsSchema,
  banAdminAccountSchema,
  unbanAdminAccountSchema,
  updateAdminAccountRoleSchema,
} from './schemas.js';

type AdminAccountsRouterDependencies = {
  authService: AuthSessionValidationPort;
  adminAccountsService: AdminAccountsPort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({
  adminAccountsService,
  authService,
}: AdminAccountsRouterDependencies) => {
  const router = Router();
  const { banAccount, listAccounts, unbanAccount, updateAccountRole } = createAdminAccountsHandlers(
    { adminAccountsService },
  );
  const protect = createRouteProtector({ authService });
  const adminRoute = (schema: ValidationSchema, ...handlers: RequestHandler[]) => [
    ...protect({ roles: ADMIN_ONLY_ROLES }),
    validate(schema),
    ...handlers,
  ];

  router.get('/users', ...adminRoute(adminAccountsSchema, listAccounts));
  router.post('/users/:userId/ban', ...adminRoute(banAdminAccountSchema, banAccount));
  router.post('/users/:userId/unban', ...adminRoute(unbanAdminAccountSchema, unbanAccount));
  router.patch(
    '/users/:userId/role',
    ...adminRoute(updateAdminAccountRoleSchema, updateAccountRole),
  );

  return router;
};

export { routeDocs };
