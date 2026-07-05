import type { AdminRoutePort } from '../../services/admin.types.js';

export type AdminControllerDependencies = {
  adminService: AdminRoutePort;
};
