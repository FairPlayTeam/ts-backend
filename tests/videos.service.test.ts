import { describe, expect, test } from 'bun:test';
import { Prisma } from '@prisma/client';
import { createVideosService } from '../src/services/videos.service.js';
import {
  ActiveVideoUploadSessionExistsError,
  InvalidVideoUploadSessionStateError,
} from '../src/services/videos.errors.js';
import type { VideosDependencies } from '../src/services/videos/videos.dependencies.js';
import type { VideoUploadSession } from '../src/services/videos.types.js';
import {
  createVideoPublicId,
  VIDEO_PUBLIC_ID_PATTERN,
} from '../src/services/videos/videoPublicId.js';

const userId = '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f';
const videoId = '0d4e55cb-c278-4d74-a192-bf7c10888c7a';
const uploadSessionId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-01-01T00:00:00.000Z');
const expiresAt = new Date('2026-01-02T00:00:00.000Z');

const createPublicIdCollisionError = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on publicId', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      target: ['publicId'],
    },
  });

const createUploadSession = (overrides: Partial<VideoUploadSession> = {}): VideoUploadSession => ({
  id: uploadSessionId,
  videoId,
  userId,
  status: 'initiated',
  bucket: 'videos',
  objectKey: `${userId}/${videoId}/original.mp4`,
  uploadId: 'upload-id',
  partSizeBytes: 67_108_864,
  partCount: null,
  expiresAt,
  completedAt: null,
  abortedAt: null,
  createdAt: now,
  updatedAt: now,
  parts: [],
  ...overrides,
});

const createDeps = ({
  activeSession = null,
  publicIdCollisionsBeforeSuccess = 0,
  publicIds = ['AbCdEf123_'],
  session = createUploadSession(),
  video = { id: videoId, ownerId: userId, processingStatus: 'draft' },
}: {
  activeSession?: { id: string } | null;
  publicIdCollisionsBeforeSuccess?: number;
  publicIds?: string[];
  session?: VideoUploadSession;
  video?: { id: string; ownerId: string; processingStatus: string } | null;
} = {}) => {
  type Calls = {
    abortMultipartUpload: unknown[];
    completeMultipartUpload: unknown[];
    initiateMultipartUpload: unknown[];
    sessionCreate: unknown[];
    sessionFindFirst: unknown[];
    sessionUpdate: unknown[];
    sessionUpdateMany: unknown[];
    signMultipartUploadPart: unknown[];
    transaction: unknown[];
    videoCreate: unknown[];
    videoFindFirst: unknown[];
    videoUpdate: unknown[];
  };
  const calls: Calls = {
    abortMultipartUpload: [],
    completeMultipartUpload: [],
    initiateMultipartUpload: [],
    sessionCreate: [],
    sessionFindFirst: [],
    sessionUpdate: [],
    sessionUpdateMany: [],
    signMultipartUploadPart: [],
    transaction: [],
    videoCreate: [],
    videoFindFirst: [],
    videoUpdate: [],
  };
  let remainingPublicIdCollisions = publicIdCollisionsBeforeSuccess;
  const prisma = {
    video: {
      create: async (args: {
        data: {
          allowComments: boolean;
          description: string | null;
          license: string;
          moderationStatus: string;
          ownerId: string;
          processingStatus: string;
          publicId: string;
          tags: string[];
          title: string;
          visibility: string;
        };
      }) => {
        if (remainingPublicIdCollisions > 0) {
          remainingPublicIdCollisions -= 1;
          throw createPublicIdCollisionError();
        }

        calls.videoCreate.push(args);

        return {
          id: videoId,
          publicId: args.data.publicId,
          ownerId: args.data.ownerId,
          title: args.data.title,
          description: args.data.description,
          tags: args.data.tags,
          license: args.data.license,
          visibility: args.data.visibility,
          allowComments: args.data.allowComments,
          processingStatus: args.data.processingStatus,
          moderationStatus: args.data.moderationStatus,
          createdAt: now,
          updatedAt: now,
        };
      },
      findFirst: async (args: unknown) => {
        calls.videoFindFirst.push(args);

        return video;
      },
      update: async (args: unknown) => {
        calls.videoUpdate.push(args);

        return video;
      },
    },
    videoUploadSession: {
      updateMany: async (args: unknown) => {
        calls.sessionUpdateMany.push(args);

        return { count: 0 };
      },
      findFirst: async (args: { where?: { id?: string } }) => {
        calls.sessionFindFirst.push(args);

        return args.where?.id ? session : activeSession;
      },
      create: async (args: { data: Partial<VideoUploadSession> }) => {
        calls.sessionCreate.push(args);

        return createUploadSession({
          ...args.data,
          expiresAt: args.data.expiresAt ?? expiresAt,
        });
      },
      update: async (args: { data?: Partial<VideoUploadSession> }) => {
        calls.sessionUpdate.push(args);

        return createUploadSession(args.data);
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      calls.transaction.push('callback');

      return callback(prisma);
    },
  };
  const objectStorage = {
    bucket: 'videos',
    initiateMultipartUpload: async (input: unknown) => {
      calls.initiateMultipartUpload.push(input);

      return { uploadId: 'upload-id' };
    },
    signMultipartUploadPart: async (input: { partNumber: number }) => {
      calls.signMultipartUploadPart.push(input);

      return `signed:${input.partNumber}`;
    },
    completeMultipartUpload: async (input: unknown) => {
      calls.completeMultipartUpload.push(input);
    },
    abortMultipartUpload: async (input: unknown) => {
      calls.abortMultipartUpload.push(input);
    },
  };
  const deps = {
    prisma,
    objectStorage,
    clock: {
      now: () => now,
    },
    publicIdGenerator: {
      generate: () => publicIds.shift() ?? 'ZyXwVu987_',
    },
    config: {
      maxPartCount: 10_000,
      partSizeBytes: 67_108_864,
      sessionTtlSeconds: 86_400,
    },
  } as unknown as VideosDependencies;

  return { calls, deps };
};

describe('videos service multipart uploads', () => {
  test('generates v1-compatible short public ids', () => {
    expect(createVideoPublicId()).toMatch(VIDEO_PUBLIC_ID_PATTERN);
  });

  test('creates draft video metadata and keeps pending videos unlisted', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);

    await expect(
      service.createVideo({
        userId,
        title: 'FairPlay launch recap',
        description: '  Launch behind the scenes  ',
        tags: ['fairplay', 'launch'],
        license: 'all_rights_reserved',
        visibility: 'public',
        allowComments: false,
      }),
    ).resolves.toMatchObject({
      video: {
        id: videoId,
        publicId: 'AbCdEf123_',
        ownerId: userId,
        title: 'FairPlay launch recap',
        description: 'Launch behind the scenes',
        tags: ['fairplay', 'launch'],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: false,
        processingStatus: 'draft',
        moderationStatus: 'pending',
      },
    });
    expect(calls.videoCreate.at(-1)).toMatchObject({
      data: {
        ownerId: userId,
        publicId: 'AbCdEf123_',
        title: 'FairPlay launch recap',
        description: 'Launch behind the scenes',
        tags: ['fairplay', 'launch'],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: false,
        processingStatus: 'draft',
        moderationStatus: 'pending',
      },
    });
  });

  test('retries video creation when the generated public id collides', async () => {
    const { calls, deps } = createDeps({
      publicIdCollisionsBeforeSuccess: 1,
      publicIds: ['AbCdEf123_', 'GhIjKl456_'],
    });
    const service = createVideosService(deps);

    await expect(
      service.createVideo({
        userId,
        title: 'FairPlay launch recap',
        description: null,
        tags: [],
        license: 'all_rights_reserved',
        visibility: 'unlisted',
        allowComments: true,
      }),
    ).resolves.toMatchObject({
      video: {
        publicId: 'GhIjKl456_',
      },
    });
    expect(calls.videoCreate).toHaveLength(1);
    expect(calls.videoCreate.at(-1)).toMatchObject({
      data: {
        publicId: 'GhIjKl456_',
      },
    });
  });

  test('initializes a multipart upload for an owned draft video', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);

    const result = await service.initMultipartUpload({ userId, videoId });

    expect(result.uploadSession).toMatchObject({
      status: 'initiated',
      bucket: 'videos',
      objectKey: `${userId}/${videoId}/original.mp4`,
      uploadId: 'upload-id',
      partSizeBytes: 67_108_864,
      expiresAt,
    });
    expect(calls.initiateMultipartUpload).toEqual([
      {
        objectKey: `${userId}/${videoId}/original.mp4`,
        contentType: 'video/mp4',
      },
    ]);
    expect(calls.videoUpdate.at(-1)).toEqual({
      where: { id: videoId },
      data: { processingStatus: 'uploading' },
    });
    expect(calls.sessionCreate.at(-1)).toMatchObject({
      data: {
        videoId,
        userId,
        status: 'initiated',
        bucket: 'videos',
        objectKey: `${userId}/${videoId}/original.mp4`,
        uploadId: 'upload-id',
      },
    });
  });

  test('does not initiate S3 upload when an active session already exists', async () => {
    const { calls, deps } = createDeps({
      activeSession: { id: uploadSessionId },
    });
    const service = createVideosService(deps);

    await expect(service.initMultipartUpload({ userId, videoId })).rejects.toBeInstanceOf(
      ActiveVideoUploadSessionExistsError,
    );
    expect(calls.initiateMultipartUpload).toEqual([]);
  });

  test('signs requested upload parts and marks an initiated session as uploading', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);

    await expect(
      service.signMultipartUploadParts({
        userId,
        videoId,
        uploadSessionId,
        partNumbers: [1, 2],
      }),
    ).resolves.toEqual({
      uploadSessionId,
      parts: [
        { partNumber: 1, url: 'signed:1' },
        { partNumber: 2, url: 'signed:2' },
      ],
    });
    expect(calls.sessionUpdate.at(-1)).toEqual({
      where: { id: uploadSessionId },
      data: { status: 'uploading' },
      select: { id: true },
    });
    expect(calls.signMultipartUploadPart).toEqual([
      {
        objectKey: `${userId}/${videoId}/original.mp4`,
        uploadId: 'upload-id',
        partNumber: 1,
      },
      {
        objectKey: `${userId}/${videoId}/original.mp4`,
        uploadId: 'upload-id',
        partNumber: 2,
      },
    ]);
  });

  test('completes S3 multipart upload and persists completed parts', async () => {
    const { calls, deps } = createDeps({
      session: createUploadSession({ status: 'uploading' }),
    });
    const service = createVideosService(deps);

    const result = await service.completeMultipartUpload({
      userId,
      videoId,
      uploadSessionId,
      parts: [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: '"etag-1"' },
      ],
    });

    expect(result.uploadSession).toMatchObject({
      status: 'completed',
      partCount: 2,
      completedAt: now,
    });
    expect(calls.completeMultipartUpload).toEqual([
      {
        objectKey: `${userId}/${videoId}/original.mp4`,
        uploadId: 'upload-id',
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      },
    ]);
    expect(calls.sessionUpdate.at(-1)).toMatchObject({
      where: { id: uploadSessionId },
      data: {
        status: 'completed',
        partCount: 2,
        completedAt: now,
        parts: {
          createMany: {
            data: [
              { partNumber: 1, etag: '"etag-1"' },
              { partNumber: 2, etag: '"etag-2"' },
            ],
            skipDuplicates: true,
          },
        },
      },
    });
    expect(calls.videoUpdate.at(-1)).toEqual({
      where: { id: videoId },
      data: { sourceObjectKey: `${userId}/${videoId}/original.mp4` },
    });
  });

  test('rejects invalid completed part lists before touching S3', async () => {
    const { calls, deps } = createDeps();
    const service = createVideosService(deps);

    await expect(
      service.completeMultipartUpload({
        userId,
        videoId,
        uploadSessionId,
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 1, etag: '"etag-duplicate"' },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidVideoUploadSessionStateError);
    expect(calls.completeMultipartUpload).toEqual([]);
  });

  test('aborts an active upload session', async () => {
    const { calls, deps } = createDeps({
      session: createUploadSession({ status: 'uploading' }),
      video: { id: videoId, ownerId: userId, processingStatus: 'uploading' },
    });
    const service = createVideosService(deps);

    await expect(
      service.abortMultipartUpload({ userId, videoId, uploadSessionId }),
    ).resolves.toMatchObject({
      uploadSession: {
        status: 'aborted',
        abortedAt: now,
      },
    });
    expect(calls.abortMultipartUpload).toEqual([
      {
        objectKey: `${userId}/${videoId}/original.mp4`,
        uploadId: 'upload-id',
      },
    ]);
    expect(calls.videoUpdate.at(-1)).toEqual({
      where: { id: videoId },
      data: { processingStatus: 'draft' },
    });
  });
});
