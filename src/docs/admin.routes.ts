import { adminAccountRouteDocs } from './admin/accounts.routes.js';
import type { RouteDoc } from './registry.js';

export const routeDocs = [...adminAccountRouteDocs] satisfies RouteDoc[];
