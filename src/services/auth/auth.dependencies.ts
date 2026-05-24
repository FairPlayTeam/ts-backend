import type { PrismaClient } from '@prisma/client';

type Prisma = Pick<PrismaClient, '$transaction' | 'emailVerificationToken' | 'session' | 'user'>;

export type AuthDependencies = {
  isUniqueError(err: unknown): boolean;
  prisma: Prisma;
  hasher: {
    hash(password: string, rounds: number): Promise<string>;
    compare(password: string, hash: string): Promise<boolean>;
  };
  token: {
    generate(): string;
    hash(token: string): string;
  };
  mailer: {
    sendVerificationEmail(email: string, token: string): Promise<void>;
  };
  clock: {
    now(): Date;
  };
  config: {
    bcryptRounds: number;
    emailVerificationTokenTtlMs: number;
    sessionTtlMs: number;
  };
  logger: {
    warn(data: object, message: string): void;
  };
};
