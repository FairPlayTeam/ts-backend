import { sendAccountBannedEmail, sendVideoRejectedEmail } from './mailer.instance.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createAdminService } from './services/admin.service.js';

export const adminService = createAdminService({
  prisma,
  mailer: {
    sendAccountBannedEmail,
    sendVideoRejectedEmail,
  },
  clock: {
    now: () => new Date(),
  },
  logger,
});
