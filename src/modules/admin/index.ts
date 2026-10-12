import type { AdminDependencies } from './dependencies.js';
import { createAdminAccountsService } from './accounts/service.js';
import type { AdminAccountsPort } from './accounts/types.js';
import { createVideoModerationService } from './videoModeration/service.js';
import type { VideoModerationPort } from './videoModeration/types.js';
import { adminAccountsHttpModule } from './http/accounts/module.js';
import { videoModerationHttpModule } from './http/videoModeration/module.js';

export type AdminService = AdminAccountsPort & VideoModerationPort;

export const createAdminService = (deps: AdminDependencies): AdminService => ({
  ...createAdminAccountsService(deps),
  ...createVideoModerationService(deps),
});

export { adminAccountsHttpModule, videoModerationHttpModule };
export type { AdminDependencies } from './dependencies.js';
export * from './errors.js';
export * from './accounts/types.js';
export * from './videoModeration/types.js';
