import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';

type Prisma = Pick<PrismaClient, '$transaction' | 'user' | 'userFollow'>;

export type ProfilesDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>;
};
