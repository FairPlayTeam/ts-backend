import { createAdminAccountsController } from './admin/admin.accounts.controller.js';
import type { AdminControllerDependencies } from './admin/admin.controller.types.js';

export const createAdminController = (deps: AdminControllerDependencies) => {
  const accounts = createAdminAccountsController(deps);

  return {
    banAccount: accounts.banAccount,
    listAccounts: accounts.listAccounts,
  };
};
