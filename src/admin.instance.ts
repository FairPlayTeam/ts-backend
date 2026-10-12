import {
  sendAccountBannedEmail,
  sendVideoDeletionScheduledEmail,
  sendVideoRejectedEmail,
} from './mailer.instance.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createAdminService } from './modules/admin/index.js';

export const adminService = createAdminService({
  prisma,
  mailer: {
    sendAccountBannedEmail,
    sendVideoRejectedEmail,
    sendVideoDeletionScheduledEmail,
  },
  clock: {
    now: () => new Date(),
  },
  logger,
});
