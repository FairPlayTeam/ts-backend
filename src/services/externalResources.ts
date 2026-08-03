import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  ExternalResourceRole,
  ExternalResourceState,
  PrismaClient,
} from '@prisma/client';
import { HOUR_MS, MINUTE_MS } from '../config/constants.js';
import type { ObjectStorage, ObjectStorageObject } from '../lib/objectStorage.js';
import { runSerializableTransaction } from '../lib/prismaTransactions.js';

const RECONCILIATION_LEASE_MS = 5 * MINUTE_MS;
const RECONCILIATION_LIST_LIMIT = 100;
const RECONCILIATION_MAX_LIST_PASSES = 10;
const RECONCILIATION_DEFAULT_LIMIT = 50;
const RECONCILIATION_MAX_LIMIT = 200;
const LAST_ERROR_MAX_LENGTH = 1000;
const MAX_RETRY_DELAY_MS = 24 * HOUR_MS;

export const EXTERNAL_RESOURCE_QUIESCENCE_MS = HOUR_MS;
export const VIDEO_EXTERNAL_RESOURCE_ROLES = [
  'source',
  'source_thumbnail',
  'hls_artifacts',
  'thumbnail_prefix',
] as const satisfies readonly ExternalResourceRole[];
export const USER_MEDIA_EXTERNAL_RESOURCE_ROLES = [
  'user_media',
] as const satisfies readonly ExternalResourceRole[];

const targetSelect = {
  id: true,
  userId: true,
  videoId: true,
  bucket: true,
  selector: true,
  selectorKind: true,
  role: true,
  generation: true,
  expectedSizeBytes: true,
  mayHaveMultipartUpload: true,
  goal: true,
  attempts: true,
  reconciliationLeaseId: true,
} satisfies Prisma.ExternalResourceTargetSelect;

export type ExternalResourceTargetRecord = Prisma.ExternalResourceTargetGetPayload<{
  select: typeof targetSelect;
}>;

export type ExternalResourceReconciliationHandler = {
  preparePresent?(target: ExternalResourceTargetRecord): Promise<void>;
  handlePresentSizeMismatch?(
    tx: Prisma.TransactionClient,
    target: ExternalResourceTargetRecord,
    actualSizeBytes: number,
  ): Promise<void>;
  finalize?(
    tx: Prisma.TransactionClient,
    target: ExternalResourceTargetRecord,
    verifiedObject: ObjectStorageObject | null,
  ): Promise<void>;
};

type ReconciliationHandlers = Partial<
  Record<ExternalResourceRole, ExternalResourceReconciliationHandler>
>;

type ReconcileExternalResourceResult = 'confirmed' | 'redirected_absent' | 'skipped' | 'missing';

type ReconcileExternalResourcesSummary = {
  claimed: number;
  confirmed: number;
  redirectedAbsent: number;
  failed: number;
};

export class ExternalResourceNotDesiredError extends Error {
  constructor(message = 'External resource is no longer desired') {
    super(message);
    this.name = 'ExternalResourceNotDesiredError';
  }
}

export class ExternalResourceSizeMismatchError extends Error {
  constructor(readonly actualSizeBytes: number) {
    super('External resource size does not match its reservation');
    this.name = 'ExternalResourceSizeMismatchError';
  }
}

class ExternalResourceLeaseLostError extends Error {
  constructor() {
    super('External resource reconciliation lease was lost');
    this.name = 'ExternalResourceLeaseLostError';
  }
}

const normalizeLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return RECONCILIATION_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), RECONCILIATION_MAX_LIMIT);
};

export const getExternalResourceRetryDelayMs = (attempts: number): number =>
  Math.min(2 ** Math.max(attempts - 1, 0) * MINUTE_MS, MAX_RETRY_DELAY_MS);

export const getExternalResourceQuiescenceNotBefore = (requestedAt: Date): Date =>
  new Date(requestedAt.getTime() + EXTERNAL_RESOURCE_QUIESCENCE_MS);

const maxDate = (left: Date | null, right: Date): Date =>
  left && left.getTime() > right.getTime() ? left : right;

const serializeError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);

  return message.slice(0, LAST_ERROR_MAX_LENGTH);
};

export const requestExternalResourceAbsence = async (
  store: {
    externalResourceTarget: {
      findUnique(args: {
        where: { id: string };
        select: {
          state: true;
          quiescenceNotBefore: true;
          nextAttemptAt: true;
        };
      }): Promise<{
        state: ExternalResourceState;
        quiescenceNotBefore: Date | null;
        nextAttemptAt: Date;
      } | null>;
      update(args: {
        where: { id: string };
        data: {
          goal: 'absent';
          state: 'quiescing';
          quiescenceNotBefore: Date;
          nextAttemptAt: Date;
          reconciliationLeaseId: null;
          reconciliationLeaseExpiresAt: null;
        };
      }): Promise<unknown>;
    };
  },
  targetId: string,
  requestedAt: Date,
): Promise<boolean> => {
  const target = await store.externalResourceTarget.findUnique({
    where: { id: targetId },
    select: {
      state: true,
      quiescenceNotBefore: true,
      nextAttemptAt: true,
    },
  });

  if (!target || target.state === 'confirmed_absent') {
    return false;
  }

  const requestedNotBefore = getExternalResourceQuiescenceNotBefore(requestedAt);
  const quiescenceNotBefore = maxDate(target.quiescenceNotBefore, requestedNotBefore);

  await store.externalResourceTarget.update({
    where: { id: targetId },
    data: {
      goal: 'absent',
      state: 'quiescing',
      quiescenceNotBefore,
      nextAttemptAt: maxDate(target.nextAttemptAt, quiescenceNotBefore),
      reconciliationLeaseId: null,
      reconciliationLeaseExpiresAt: null,
    },
  });

  return true;
};

type ReconcilerPrisma = Pick<
  PrismaClient,
  '$transaction' | 'externalMultipartHandle' | 'externalResourceTarget'
>;

type ExternalResourceReconcilerDependencies = {
  prisma: ReconcilerPrisma;
  objectStorage: Pick<
    ObjectStorage,
    | 'abortMultipartUpload'
    | 'deleteObject'
    | 'deleteObjects'
    | 'headObject'
    | 'listMultipartUploads'
    | 'listObjects'
  >;
  clock: {
    now(): Date;
  };
  leaseIdGenerator?: {
    generate(): string;
  };
  logger: {
    warn(data: object, message: string): void;
  };
  allowedRoles?: readonly ExternalResourceRole[];
};

type ExternalResourceStorageDependencies = {
  objectStorage: ExternalResourceReconcilerDependencies['objectStorage'];
  listPersistedMultipartUploadIds(targetId: string): Promise<string[]>;
};

type ReconcileTargetInput = {
  targetId: string;
  roles: readonly ExternalResourceRole[];
  handlers?: ReconciliationHandlers;
};

type ReconcileDueTargetsInput = {
  roles: readonly ExternalResourceRole[];
  limit?: number;
  handlers?: ReconciliationHandlers;
};

export type ExternalResourceReconciler = {
  reconcileTarget(input: ReconcileTargetInput): Promise<ReconcileExternalResourceResult>;
  reconcileDue(input: ReconcileDueTargetsInput): Promise<ReconcileExternalResourcesSummary>;
};

const eligibleTargetWhere = (
  now: Date,
  roles: readonly ExternalResourceRole[],
): Prisma.ExternalResourceTargetWhereInput => ({
  role: {
    in: [...roles],
  },
  nextAttemptAt: {
    lte: now,
  },
  OR: [
    {
      goal: 'present',
      selectorKind: 'exact',
      state: 'writing',
    },
    {
      goal: 'absent',
      state: 'quiescing',
      quiescenceNotBefore: {
        lte: now,
      },
    },
    {
      goal: 'present',
      selectorKind: 'exact',
      state: 'reconciling',
      reconciliationLeaseExpiresAt: {
        lte: now,
      },
    },
    {
      goal: 'absent',
      state: 'reconciling',
      quiescenceNotBefore: {
        lte: now,
      },
      reconciliationLeaseExpiresAt: {
        lte: now,
      },
    },
  ],
});

const reconcileAbsentExact = async (
  deps: ExternalResourceStorageDependencies,
  target: ExternalResourceTargetRecord,
  renewLease: () => Promise<void>,
): Promise<void> => {
  const persistedUploadIds = await deps.listPersistedMultipartUploadIds(target.id);

  for (const uploadId of persistedUploadIds) {
    await renewLease();
    await deps.objectStorage.abortMultipartUpload({
      bucket: target.bucket,
      objectKey: target.selector,
      uploadId,
    });
  }

  if (target.mayHaveMultipartUpload || persistedUploadIds.length > 0) {
    for (let pass = 0; pass < RECONCILIATION_MAX_LIST_PASSES; pass += 1) {
      await renewLease();
      const result = await deps.objectStorage.listMultipartUploads({
        bucket: target.bucket,
        prefix: target.selector,
        limit: RECONCILIATION_LIST_LIMIT,
      });
      const matchingUploads = result.uploads.filter(
        (upload) => upload.objectKey === target.selector,
      );

      for (const upload of matchingUploads) {
        await deps.objectStorage.abortMultipartUpload({
          bucket: target.bucket,
          objectKey: target.selector,
          uploadId: upload.uploadId,
        });
      }

      if (!result.truncated) {
        break;
      }

      if (matchingUploads.length === 0) {
        throw new Error('Multipart discovery could not make bounded progress');
      }

      if (pass === RECONCILIATION_MAX_LIST_PASSES - 1) {
        throw new Error('Multipart cleanup exceeded its bounded pass limit');
      }
    }
  }

  await renewLease();
  await deps.objectStorage.deleteObject(target.selector, target.bucket);
  await renewLease();

  if (
    await deps.objectStorage.headObject({
      bucket: target.bucket,
      objectKey: target.selector,
    })
  ) {
    throw new Error('External object is still present after deletion');
  }
};

const reconcileAbsentPrefix = async (
  deps: ExternalResourceStorageDependencies,
  target: ExternalResourceTargetRecord,
  renewLease: () => Promise<void>,
): Promise<void> => {
  for (let pass = 0; pass < RECONCILIATION_MAX_LIST_PASSES; pass += 1) {
    await renewLease();
    const result = await deps.objectStorage.listObjects({
      bucket: target.bucket,
      prefix: target.selector,
      limit: RECONCILIATION_LIST_LIMIT,
    });

    if (result.objects.length === 0) {
      return;
    }

    await deps.objectStorage.deleteObjects(
      result.objects.map((object) => object.objectKey),
      target.bucket,
    );
  }

  await renewLease();
  const confirmation = await deps.objectStorage.listObjects({
    bucket: target.bucket,
    prefix: target.selector,
    limit: 1,
  });

  if (confirmation.objects.length > 0) {
    throw new Error('External prefix cleanup exceeded its bounded pass limit');
  }
};

export const reconcileExternalResourceStorage = async (
  deps: ExternalResourceStorageDependencies,
  target: ExternalResourceTargetRecord,
  handler: ExternalResourceReconciliationHandler | undefined,
  renewLease: () => Promise<void>,
): Promise<ObjectStorageObject | null> => {
  if (target.goal === 'absent') {
    if (target.selectorKind === 'exact') {
      await reconcileAbsentExact(deps, target, renewLease);
    } else {
      await reconcileAbsentPrefix(deps, target, renewLease);
    }

    return null;
  }

  if (target.selectorKind !== 'exact') {
    throw new Error('Present reconciliation only supports exact selectors');
  }

  await handler?.preparePresent?.(target);
  await renewLease();
  const object = await deps.objectStorage.headObject({
    bucket: target.bucket,
    objectKey: target.selector,
  });

  if (!object) {
    throw new Error('Reserved external object is not present');
  }

  if (target.expectedSizeBytes !== null && BigInt(object.sizeBytes) !== target.expectedSizeBytes) {
    throw new ExternalResourceSizeMismatchError(object.sizeBytes);
  }

  return object;
};

export const createExternalResourceReconciler = (
  deps: ExternalResourceReconcilerDependencies,
): ExternalResourceReconciler => {
  const generateLeaseId = (): string => deps.leaseIdGenerator?.generate() ?? randomUUID();
  const allowedRoles = deps.allowedRoles ? new Set<ExternalResourceRole>(deps.allowedRoles) : null;
  const assertAllowedRoles = (roles: readonly ExternalResourceRole[]): void => {
    const forbiddenRole = roles.find((role) => allowedRoles && !allowedRoles.has(role));

    if (forbiddenRole) {
      throw new TypeError(
        `External resource role ${forbiddenRole} is outside this reconciler scope`,
      );
    }
  };

  const claimTarget = async (
    roles: readonly ExternalResourceRole[],
    targetId?: string,
  ): Promise<ExternalResourceTargetRecord | null> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = deps.clock.now();
      const eligibility = eligibleTargetWhere(now, roles);
      const candidate = targetId
        ? await deps.prisma.externalResourceTarget.findFirst({
            where: {
              id: targetId,
              ...eligibility,
            },
            select: {
              id: true,
            },
          })
        : await deps.prisma.externalResourceTarget.findFirst({
            where: eligibility,
            select: {
              id: true,
            },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          });

      if (!candidate) {
        return null;
      }

      const leaseId = generateLeaseId();
      const leaseExpiresAt = new Date(now.getTime() + RECONCILIATION_LEASE_MS);
      const claimed = await deps.prisma.externalResourceTarget.updateMany({
        where: {
          id: candidate.id,
          ...eligibility,
        },
        data: {
          state: 'reconciling',
          reconciliationLeaseId: leaseId,
          reconciliationLeaseExpiresAt: leaseExpiresAt,
        },
      });

      if (claimed.count === 0) {
        if (targetId) {
          return null;
        }

        continue;
      }

      const claimedAt = deps.clock.now();

      return deps.prisma.externalResourceTarget.findFirst({
        where: {
          id: candidate.id,
          reconciliationLeaseId: leaseId,
          reconciliationLeaseExpiresAt: {
            gt: claimedAt,
          },
          state: 'reconciling',
        },
        select: targetSelect,
      });
    }

    return null;
  };

  const renewLease = async (target: ExternalResourceTargetRecord): Promise<void> => {
    const renewedAt = deps.clock.now();
    const leaseExpiresAt = new Date(renewedAt.getTime() + RECONCILIATION_LEASE_MS);
    const renewed = await deps.prisma.externalResourceTarget.updateMany({
      where: {
        id: target.id,
        state: 'reconciling',
        reconciliationLeaseId: target.reconciliationLeaseId,
        reconciliationLeaseExpiresAt: {
          gt: renewedAt,
        },
      },
      data: {
        reconciliationLeaseExpiresAt: leaseExpiresAt,
      },
    });

    if (renewed.count === 0) {
      throw new ExternalResourceLeaseLostError();
    }
  };

  const redirectClaimToAbsence = async (
    target: ExternalResourceTargetRecord,
    handler: ExternalResourceReconciliationHandler | undefined,
    actualSizeBytes?: number,
  ): Promise<void> => {
    const requestedAt = deps.clock.now();

    await runSerializableTransaction(deps.prisma, async (tx) => {
      const ownedTarget = await tx.externalResourceTarget.findFirst({
        where: {
          id: target.id,
          state: 'reconciling',
          reconciliationLeaseId: target.reconciliationLeaseId,
          reconciliationLeaseExpiresAt: {
            gt: requestedAt,
          },
        },
        select: {
          id: true,
          expectedSizeBytes: true,
          nextAttemptAt: true,
          quiescenceNotBefore: true,
        },
      });

      if (!ownedTarget) {
        throw new ExternalResourceLeaseLostError();
      }

      if (actualSizeBytes !== undefined) {
        await handler?.handlePresentSizeMismatch?.(tx, target, actualSizeBytes);
      }

      const transitionedAt = deps.clock.now();
      const requestedNotBefore = getExternalResourceQuiescenceNotBefore(requestedAt);
      const quiescenceNotBefore = maxDate(ownedTarget.quiescenceNotBefore, requestedNotBefore);
      const actualSize = actualSizeBytes === undefined ? null : BigInt(actualSizeBytes);
      const expectedSizeBytes =
        actualSize !== null &&
        (ownedTarget.expectedSizeBytes === null || actualSize > ownedTarget.expectedSizeBytes)
          ? actualSize
          : ownedTarget.expectedSizeBytes;
      const redirected = await tx.externalResourceTarget.updateMany({
        where: {
          id: target.id,
          state: 'reconciling',
          reconciliationLeaseId: target.reconciliationLeaseId,
          reconciliationLeaseExpiresAt: {
            gt: transitionedAt,
          },
        },
        data: {
          goal: 'absent',
          state: 'quiescing',
          expectedSizeBytes,
          quiescenceNotBefore,
          nextAttemptAt: maxDate(ownedTarget.nextAttemptAt, quiescenceNotBefore),
          reconciliationLeaseId: null,
          reconciliationLeaseExpiresAt: null,
        },
      });

      if (redirected.count === 0) {
        throw new ExternalResourceLeaseLostError();
      }
    });
  };

  const recordFailure = async (
    target: ExternalResourceTargetRecord,
    err: unknown,
  ): Promise<void> => {
    const attempts = target.attempts + 1;
    const failedAt = deps.clock.now();
    const updated = await deps.prisma.externalResourceTarget.updateMany({
      where: {
        id: target.id,
        state: 'reconciling',
        reconciliationLeaseId: target.reconciliationLeaseId,
        reconciliationLeaseExpiresAt: {
          gt: failedAt,
        },
      },
      data: {
        state: target.goal === 'present' ? 'writing' : 'quiescing',
        attempts,
        lastError: serializeError(err),
        nextAttemptAt: new Date(failedAt.getTime() + getExternalResourceRetryDelayMs(attempts)),
        reconciliationLeaseId: null,
        reconciliationLeaseExpiresAt: null,
      },
    });

    if (updated.count === 0) {
      throw new ExternalResourceLeaseLostError();
    }
  };

  const finalizeClaim = async (
    target: ExternalResourceTargetRecord,
    handler: ExternalResourceReconciliationHandler | undefined,
    verifiedObject: ObjectStorageObject | null,
  ): Promise<void> => {
    await runSerializableTransaction(deps.prisma, async (tx) => {
      const ownershipCheckedAt = deps.clock.now();
      const ownedTarget = await tx.externalResourceTarget.findFirst({
        where: {
          id: target.id,
          state: 'reconciling',
          reconciliationLeaseId: target.reconciliationLeaseId,
          reconciliationLeaseExpiresAt: {
            gt: ownershipCheckedAt,
          },
        },
        select: {
          id: true,
        },
      });

      if (!ownedTarget) {
        throw new ExternalResourceLeaseLostError();
      }

      await handler?.finalize?.(tx, target, verifiedObject);
      const confirmedAt = deps.clock.now();
      const finalized = await tx.externalResourceTarget.updateMany({
        where: {
          id: target.id,
          state: 'reconciling',
          reconciliationLeaseId: target.reconciliationLeaseId,
          reconciliationLeaseExpiresAt: {
            gt: confirmedAt,
          },
        },
        data: {
          state: target.goal === 'present' ? 'confirmed_present' : 'confirmed_absent',
          attempts: 0,
          lastError: null,
          nextAttemptAt: confirmedAt,
          mayHaveMultipartUpload: false,
          reconciliationLeaseId: null,
          reconciliationLeaseExpiresAt: null,
        },
      });

      if (finalized.count === 0) {
        throw new ExternalResourceLeaseLostError();
      }

      await tx.externalMultipartHandle.deleteMany({
        where: {
          targetId: target.id,
        },
      });
    });
  };

  const executeClaim = async (
    target: ExternalResourceTargetRecord,
    handlers: ReconciliationHandlers | undefined,
  ): Promise<'confirmed' | 'redirected_absent'> => {
    const handler = handlers?.[target.role];

    try {
      const verifiedObject = await reconcileExternalResourceStorage(
        {
          objectStorage: deps.objectStorage,
          listPersistedMultipartUploadIds: async (targetId) => {
            const handles = await deps.prisma.externalMultipartHandle.findMany({
              where: { targetId },
              select: { uploadId: true },
            });

            return handles.map((handle) => handle.uploadId);
          },
        },
        target,
        handler,
        () => renewLease(target),
      );
      await finalizeClaim(target, handler, verifiedObject);

      return 'confirmed';
    } catch (err) {
      if (err instanceof ExternalResourceNotDesiredError) {
        await redirectClaimToAbsence(target, handler);
        return 'redirected_absent';
      }

      if (err instanceof ExternalResourceLeaseLostError) {
        throw err;
      }

      if (err instanceof ExternalResourceSizeMismatchError) {
        await redirectClaimToAbsence(target, handler, err.actualSizeBytes);
        throw err;
      }

      await recordFailure(target, err);
      throw err;
    }
  };

  return {
    async reconcileTarget({ targetId, roles, handlers }) {
      assertAllowedRoles(roles);
      const existing = await deps.prisma.externalResourceTarget.findUnique({
        where: { id: targetId },
        select: {
          state: true,
        },
      });

      if (!existing) {
        return 'missing';
      }

      if (existing.state === 'confirmed_present' || existing.state === 'confirmed_absent') {
        return 'confirmed';
      }

      const target = await claimTarget(roles, targetId);

      if (!target) {
        return 'skipped';
      }

      return executeClaim(target, handlers);
    },

    async reconcileDue({ roles, limit, handlers }) {
      assertAllowedRoles(roles);
      const summary: ReconcileExternalResourcesSummary = {
        claimed: 0,
        confirmed: 0,
        redirectedAbsent: 0,
        failed: 0,
      };

      for (let index = 0; index < normalizeLimit(limit); index += 1) {
        const target = await claimTarget(roles);

        if (!target) {
          break;
        }

        summary.claimed += 1;

        try {
          const result = await executeClaim(target, handlers);

          if (result === 'confirmed') {
            summary.confirmed += 1;
          } else {
            summary.redirectedAbsent += 1;
          }
        } catch (err) {
          summary.failed += 1;
          deps.logger.warn(
            {
              err,
              targetId: target.id,
              role: target.role,
              selectorKind: target.selectorKind,
            },
            'External resource reconciliation failed',
          );
        }
      }

      return summary;
    },
  };
};
