import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../../lib/objectStorage.js';
import type { ExternalResourceReconciler } from '../externalResources.js';
import type { UserMediaProcessor } from '../userMedia/userMedia.processor.js';

type Prisma = Pick<
  PrismaClient,
  | '$transaction'
  | 'comment'
  | 'emailVerificationToken'
  | 'externalResourceTarget'
  | 'passwordResetToken'
  | 'session'
  | 'user'
  | 'userMediaAsset'
  | 'videoRating'
  | 'videoView'
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
    hashAuthCode(secret: string): string;
    hashOpaqueToken(token: string): string;
  };
  mailer: {
    sendVerificationEmail(email: string, code: string): Promise<void>;
    sendPasswordResetEmail(email: string, code: string): Promise<void>;
  };
  objectStorage: Pick<ObjectStorage, 'bucket' | 'putObject'>;
  externalResources: Pick<ExternalResourceReconciler, 'reconcileDue' | 'reconcileTarget'>;
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
