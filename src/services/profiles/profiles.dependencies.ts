import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';

type Prisma = Pick<PrismaClient, '$transaction' | 'user' | 'userFollow' | 'userMediaAsset'>;

export type ProfilesDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'readObject'>;
  maxProxyBytes: {
    avatar: number;
    banner: number;
  };
};
