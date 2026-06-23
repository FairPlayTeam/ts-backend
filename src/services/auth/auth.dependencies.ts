import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { UserMediaProcessor } from '../userMedia/userMedia.processor.js';

type Prisma = Pick<
  PrismaClient,
  | '$transaction'
  | 'emailVerificationToken'
  | 'passwordResetToken'
  | 'session'
  | 'user'
  | 'userMediaAsset'
  | 'userMediaDeletionJob'
>;

export type AuthDependencies = {
  isUniqueError(err: unknown): boolean;
  prisma: Prisma;
  hasher: {
    hash(password: string, rounds: number): Promise<string>;
    compare(password: string, hash: string): Promise<boolean>;
  };
  token: {
    generate(): string;
    generateSixDigitCode(): string;
    hash(token: string): string;
  };
  mailer: {
    sendVerificationEmail(email: string, code: string): Promise<void>;
    sendPasswordResetEmail(email: string, token: string): Promise<void>;
  };
  objectStorage: Pick<ObjectStorage, 'putObject' | 'deleteObject' | 'getSignedUrl'>;
  userMediaProcessor: UserMediaProcessor;
  clock: {
    now(): Date;
  };
  config: {
    bcryptRounds: number;
    emailVerificationTokenTtlMs: number;
    passwordResetTokenTtlMs: number;
    sessionTtlMs: number;
  };
  logger: {
    warn(data: object, message: string): void;
  };
};
