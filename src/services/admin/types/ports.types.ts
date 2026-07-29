import type { AdminAccountsPort } from './accounts.types.js';
import type { AdminVideosPort } from './videos.types.js';

export type AdminRoutePort = AdminAccountsPort & AdminVideosPort;

export type AdminPorts = AdminRoutePort;
