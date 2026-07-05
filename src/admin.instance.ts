import { objectStorage } from './objectStorage.instance.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { createAdminService } from './services/admin.service.js';

export const adminService = createAdminService({
  prisma,
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
});
