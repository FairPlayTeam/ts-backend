import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';

type Prisma = Pick<PrismaClient, 'user'>;

export type ProfilesDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'getSignedUrl'>;
};
