import { createAdminAccountsController } from './admin/admin.accounts.controller.js';
import type { AdminControllerDependencies } from './admin/admin.controller.types.js';
import { createAdminVideosController } from './admin/admin.videos.controller.js';

export const createAdminController = (deps: AdminControllerDependencies) => {
  const accounts = createAdminAccountsController(deps);
  const videos = createAdminVideosController(deps);

  return {
    banAccount: accounts.banAccount,
    listAccounts: accounts.listAccounts,
    listVideos: videos.listVideos,
    moderateVideo: videos.moderateVideo,
    unbanAccount: accounts.unbanAccount,
    updateAccountRole: accounts.updateAccountRole,
  };
};
