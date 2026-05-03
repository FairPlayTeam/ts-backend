import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import config from '../config/env.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const createPrismaClient = (): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.databaseUrl }),
  });

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

export function isPrismaUniqueError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
