import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';

type Prisma = Pick<PrismaClient, '$transaction' | 'user'>;

export type AdminDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>;
};
