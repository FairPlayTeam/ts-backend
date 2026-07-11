import type {
  CreateVideoResult,
  ListMyVideosResult,
  SignVideoMultipartUploadPartsResult,
  VideoUploadSessionResult,
  VideosPorts,
} from '../../src/services/videos.types.js';

const fixedNow = new Date('2026-01-01T00:00:00.000Z');
const fixedExpiresAt = new Date('2026-01-02T00:00:00.000Z');

const createVideoResult = (
  overrides: Partial<CreateVideoResult['video']> = {},
): CreateVideoResult => ({
  video: {
    id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    publicId: 'AbCdEf123_',
    ownerId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    title: 'FairPlay launch recap',
    description: null,
    tags: [],
    license: 'all_rights_reserved',
    visibility: 'unlisted',
    allowComments: true,
    processingStatus: 'draft',
    moderationStatus: 'pending',
    createdAt: fixedNow,
    updatedAt: fixedNow,
    ...overrides,
  },
});

const createUploadSessionResult = (
  overrides: Partial<VideoUploadSessionResult['uploadSession']> = {},
): VideoUploadSessionResult => ({
  uploadSession: {
    id: '0d4e55cb-c278-4d74-a192-bf7c10888c7a',
    videoId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    userId: '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f',
    status: 'initiated',
    bucket: 'videos',
    objectKey:
      '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/original.mp4',
    uploadId: 'test-upload-id',
    partSizeBytes: 67_108_864,
    partCount: null,
    expiresAt: fixedExpiresAt,
    completedAt: null,
    abortedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    parts: [],
    ...overrides,
  },
});

const listMyVideosResult = (): ListMyVideosResult => ({
  videos: [
    createVideoResult({
      processingStatus: 'uploading',
    }).video,
  ],
  total: 1,
  nextCursor: null,
});

export const createStubVideosService = (): VideosPorts => ({
  createVideo: async (input) =>
    createVideoResult({
      ownerId: input.userId,
      title: input.title,
      description: input.description ?? null,
      tags: input.tags,
      license: input.license,
      allowComments: input.allowComments,
    }),
  listMyVideos: async () => listMyVideosResult(),
  initMultipartUpload: async () => createUploadSessionResult(),
  signMultipartUploadParts: async (input): Promise<SignVideoMultipartUploadPartsResult> => ({
    uploadSessionId: input.uploadSessionId,
    parts: input.partNumbers.map((partNumber) => ({
      partNumber,
      url: `http://localhost:9000/videos/user-id/video-id/original.mp4?partNumber=${partNumber}&uploadId=test-upload-id`,
    })),
  }),
  completeMultipartUpload: async () =>
    createUploadSessionResult({
      status: 'completed',
      partCount: 1,
      completedAt: fixedNow,
      parts: [
        {
          partNumber: 1,
          etag: '"etag-1"',
          sizeBytes: null,
          createdAt: fixedNow,
        },
      ],
    }),
  abortMultipartUpload: async () =>
    createUploadSessionResult({
      status: 'aborted',
      abortedAt: fixedNow,
    }),
  getMultipartUploadSession: async () => createUploadSessionResult(),
});
