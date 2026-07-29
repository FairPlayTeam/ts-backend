import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';

type Prisma = Pick<PrismaClient, '$transaction' | 'session' | 'user' | 'video'>;

export type AdminDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>;
  mailer: {
    sendAccountBannedEmail(email: string, reason: string): Promise<void>;
  };
  clock: {
    now(): Date;
  };
  logger: {
    warn(data: object, message: string): void;
  };
};
