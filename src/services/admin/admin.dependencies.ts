import type { PrismaClient } from '@prisma/client';

type Prisma = Pick<PrismaClient, '$transaction' | 'session' | 'user' | 'video'>;

export type AdminDependencies = {
  prisma: Prisma;
  mailer: {
    sendAccountBannedEmail(email: string, reason: string): Promise<void>;
    sendVideoRejectedEmail(email: string, title: string, reason: string): Promise<void>;
    sendVideoDeletionScheduledEmail(email: string, title: string, reason: string): Promise<void>;
  };
  clock: {
    now(): Date;
  };
  logger: {
    warn(data: object, message: string): void;
  };
};
