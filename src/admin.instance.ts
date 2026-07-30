import { sendAccountBannedEmail, sendVideoRejectedEmail } from './mailer.instance.js';
import { objectStorage } from './objectStorage.instance.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createAdminService } from './services/admin.service.js';

export const adminService = createAdminService({
  prisma,
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
  mailer: {
    sendAccountBannedEmail,
    sendVideoRejectedEmail,
  },
  clock: {
    now: () => new Date(),
  },
  logger,
});
