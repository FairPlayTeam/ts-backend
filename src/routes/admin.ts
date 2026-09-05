import { Router, type RequestHandler } from 'express';
import { createAdminController } from '../controllers/admin.controller.js';
import {
  adminAccountsSchema,
  banAdminAccountSchema,
  unbanAdminAccountSchema,
  updateAdminAccountRoleSchema,
} from '../controllers/admin.schemas.js';
import { createRouteProtector } from '../middleware/routeProtection.js';
import { validate } from '../middleware/validation.js';
import type { AdminRoutePort } from '../services/admin.types.js';
import type { AuthSessionValidationPort } from '../services/auth.types.js';
import { ADMIN_ONLY_ROLES } from '../services/auth.roles.js';

type AdminRouterDependencies = {
  authService: AuthSessionValidationPort;
  adminService: AdminRoutePort;
};

type ValidationSchema = Parameters<typeof validate>[0];

export const createRouter = ({ adminService, authService }: AdminRouterDependencies) => {
  const router = Router();
  const { banAccount, listAccounts, unbanAccount, updateAccountRole } = createAdminController({
    adminService,
  });
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

export { routeDocs } from '../docs/admin.routes.js';
