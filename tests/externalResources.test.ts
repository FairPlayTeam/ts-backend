import { describe, expect, test } from 'bun:test';
import {
  EXTERNAL_RESOURCE_QUIESCENCE_MS,
  ExternalResourceSizeMismatchError,
  USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
  VIDEO_EXTERNAL_RESOURCE_ROLES,
  createExternalResourceReconciler,
  getExternalResourceQuiescenceNotBefore,
  getExternalResourceRetryDelayMs,
  reconcileExternalResourceStorage,
  requestExternalResourceAbsence,
  type ExternalResourceTargetRecord,
} from '../src/services/externalResources.js';

const createTarget = (
  overrides: Partial<ExternalResourceTargetRecord> = {},
): ExternalResourceTargetRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  videoId: '33333333-3333-4333-8333-333333333333',
  bucket: 'videos',
  selector: 'user/video/source.mp4',
  selectorKind: 'exact',
  role: 'source',
  generation: 'generation-id',
  expectedSizeBytes: 100n,
  mayHaveMultipartUpload: true,
  goal: 'absent',
  attempts: 0,
  reconciliationLeaseId: '44444444-4444-4444-8444-444444444444',
  ...overrides,
});

describe('external resource reconciliation', () => {
  test('uses exponential retry backoff capped at 24 hours', () => {
    expect(getExternalResourceRetryDelayMs(1)).toBe(60_000);
    expect(getExternalResourceRetryDelayMs(2)).toBe(120_000);
    expect(getExternalResourceRetryDelayMs(5)).toBe(960_000);
    expect(getExternalResourceRetryDelayMs(100)).toBe(24 * 60 * 60 * 1000);
  });

  test('uses a fixed one-hour quiescence delay', () => {
    const requestedAt = new Date('2026-01-01T00:00:00.000Z');

    expect(EXTERNAL_RESOURCE_QUIESCENCE_MS).toBe(60 * 60 * 1000);
    expect(getExternalResourceQuiescenceNotBefore(requestedAt)).toEqual(
      new Date('2026-01-01T01:00:00.000Z'),
    );
  });

  test('never shortens an existing quiescence or next-attempt deadline', async () => {
    let update: unknown;
    const store = {
      externalResourceTarget: {
        findUnique: async () => ({
          state: 'quiescing' as const,
          quiescenceNotBefore: new Date('2026-01-01T04:00:00.000Z'),
          nextAttemptAt: new Date('2026-01-01T05:00:00.000Z'),
        }),
        update: async (args: unknown) => {
          update = args;
          return {};
        },
      },
    };

    await requestExternalResourceAbsence(
      store,
      '11111111-1111-4111-8111-111111111111',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(update).toEqual({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: {
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: new Date('2026-01-01T04:00:00.000Z'),
        nextAttemptAt: new Date('2026-01-01T05:00:00.000Z'),
        reconciliationLeaseId: null,
        reconciliationLeaseExpiresAt: null,
      },
    });
  });

  test('reconciles an exact selector without inferring prefix semantics from its text', async () => {
    const calls: unknown[] = [];
    let headCalls = 0;
    const target = createTarget({
      selector: 'uploads/key-ending-with-a-slash/',
      selectorKind: 'exact',
    });

    await reconcileExternalResourceStorage(
      {
        listPersistedMultipartUploadIds: async () => ['persisted-upload'],
        objectStorage: {
          abortMultipartUpload: async (input) => {
            calls.push(['abort', input]);
          },
          deleteObject: async (objectKey, bucket) => {
            calls.push(['delete-object', objectKey, bucket]);
          },
          deleteObjects: async () => {
            throw new Error('prefix deletion must not be used');
          },
          headObject: async (input) => {
            headCalls += 1;
            calls.push(['head', input]);
            return null;
          },
          listMultipartUploads: async (input) => {
            calls.push(['list-multipart', input]);
            return {
              uploads: [
                {
                  objectKey: target.selector,
                  uploadId: 'discovered-upload',
                },
                {
                  objectKey: `${target.selector}other`,
                  uploadId: 'unrelated-upload',
                },
              ],
              truncated: false,
            };
          },
          listObjects: async () => {
            throw new Error('prefix listing must not be used');
          },
        },
      },
      target,
      undefined,
      async () => {
        calls.push(['renew']);
      },
    );

    expect(headCalls).toBe(1);
    expect(calls).toContainEqual([
      'abort',
      {
        bucket: 'videos',
        objectKey: target.selector,
        uploadId: 'persisted-upload',
      },
    ]);
    expect(calls).toContainEqual([
      'abort',
      {
        bucket: 'videos',
        objectKey: target.selector,
        uploadId: 'discovered-upload',
      },
    ]);
    expect(calls).not.toContainEqual([
      'abort',
      expect.objectContaining({ uploadId: 'unrelated-upload' }),
    ]);
    expect(calls).toContainEqual(['delete-object', target.selector, 'videos']);
  });

  test('exhaustively deletes a prefix in bounded batches and confirms absence', async () => {
    const deleted: string[][] = [];
    let listCalls = 0;
    const target = createTarget({
      selector: 'users/video/generations/generation-id/',
      selectorKind: 'prefix',
      role: 'hls_artifacts',
      expectedSizeBytes: null,
      mayHaveMultipartUpload: false,
    });

    await reconcileExternalResourceStorage(
      {
        listPersistedMultipartUploadIds: async () => [],
        objectStorage: {
          abortMultipartUpload: async () => {
            throw new Error('multipart abort must not be used');
          },
          deleteObject: async () => {
            throw new Error('exact deletion must not be used');
          },
          deleteObjects: async (objectKeys, bucket) => {
            expect(bucket).toBe('videos');
            deleted.push([...objectKeys]);
          },
          headObject: async () => {
            throw new Error('HEAD must not be used for a prefix');
          },
          listMultipartUploads: async () => {
            throw new Error('multipart listing must not be used');
          },
          listObjects: async ({ prefix, bucket, limit }) => {
            expect({ prefix, bucket, limit }).toEqual({
              prefix: target.selector,
              bucket: 'videos',
              limit: 100,
            });
            listCalls += 1;

            return listCalls === 1
              ? {
                  objects: [
                    { objectKey: `${target.selector}master.m3u8`, sizeBytes: 1 },
                    { objectKey: `${target.selector}segment.ts`, sizeBytes: 1 },
                  ],
                  truncated: false,
                }
              : { objects: [], truncated: false };
          },
        },
      },
      target,
      undefined,
      async () => undefined,
    );

    expect(deleted).toEqual([[`${target.selector}master.m3u8`, `${target.selector}segment.ts`]]);
    expect(listCalls).toBe(2);
  });

  test('requires present exact objects and validates their expected size', async () => {
    let prepared = false;
    const target = createTarget({
      goal: 'present',
    });
    const objectStorage = {
      abortMultipartUpload: async () => undefined,
      deleteObject: async () => undefined,
      deleteObjects: async () => undefined,
      headObject: async () => ({
        objectKey: target.selector,
        sizeBytes: 99,
      }),
      listMultipartUploads: async () => ({ uploads: [], truncated: false }),
      listObjects: async () => ({ objects: [], truncated: false }),
    };

    await expect(
      reconcileExternalResourceStorage(
        {
          listPersistedMultipartUploadIds: async () => [],
          objectStorage,
        },
        target,
        {
          preparePresent: async () => {
            prepared = true;
          },
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(ExternalResourceSizeMismatchError);
    expect(prepared).toBe(true);
  });

  test('keeps video cleanup role scope separate from user media', () => {
    expect(VIDEO_EXTERNAL_RESOURCE_ROLES).toEqual([
      'source',
      'source_thumbnail',
      'hls_artifacts',
      'thumbnail_prefix',
    ]);
    expect(VIDEO_EXTERNAL_RESOURCE_ROLES).not.toContain('user_media');
    expect(USER_MEDIA_EXTERNAL_RESOURCE_ROLES).toEqual(['user_media']);
  });

  test('rejects reconciliation roles outside an explicitly scoped reconciler', async () => {
    const reconciler = createExternalResourceReconciler({
      prisma: {} as never,
      objectStorage: {} as never,
      clock: { now: () => new Date() },
      logger: { warn: () => undefined },
      allowedRoles: USER_MEDIA_EXTERNAL_RESOURCE_ROLES,
    });

    await expect(reconciler.reconcileDue({ roles: ['source'] })).rejects.toThrow(
      'External resource role source is outside this reconciler scope',
    );
  });
});
