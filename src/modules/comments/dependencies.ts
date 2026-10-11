import type { PrismaClient } from '@prisma/client';

type Prisma = Pick<
  PrismaClient,
  '$queryRaw' | '$transaction' | 'comment' | 'commentLike' | 'video'
>;

export type CommentsDependencies = {
  prisma: Prisma;
  clock: {
    now(): Date;
  };
};
