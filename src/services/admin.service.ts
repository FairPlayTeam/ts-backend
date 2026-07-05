import type { AdminDependencies } from './admin/admin.dependencies.js';
import { createAdminAccountsService } from './admin/admin.accounts.js';
import type { AdminPorts } from './admin/types/ports.types.js';

export const createAdminService = (deps: AdminDependencies): AdminPorts => ({
  ...createAdminAccountsService(deps),
});
