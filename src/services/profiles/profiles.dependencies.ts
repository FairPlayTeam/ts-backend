import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { FollowingProfilesCursorCodec } from './followingProfilesCursor.js';

type Prisma = Pick<PrismaClient, '$transaction' | 'user' | 'userFollow' | 'userMediaAsset'>;

export type ProfilesDependencies = {
  prisma: Prisma;
  objectStorage: Pick<ObjectStorage, 'readObject'>;
  followingProfilesCursorCodec: FollowingProfilesCursorCodec;
  maxProxyBytes: {
    avatar: number;
    banner: number;
  };
};
