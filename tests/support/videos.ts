import type {
  CreateVideoResult,
  GetPublicVideoDetailResult,
  ListMyVideosResult,
  ListPublicVideosResult,
  SearchPublicVideosResult,
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailResult,
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
    title: 'Me at the zoo',
    description: null,
    tags: [],
    license: 'all_rights_reserved',
    visibility: 'unlisted',
    allowComments: true,
    processingStatus: 'draft',
    moderationStatus: 'pending',
    thumbnailPath: null,
    ratingAverage: 0,
    ratingCount: 0,
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
      '9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/9fdf5eb1-6d1d-4718-9f1b-5bdb9dd8e54f/sources/0d4e55cb-c278-4d74-a192-bf7c10888c7a/original.mp4',
    uploadId: 'test-upload-id',
    partSizeBytes: 67_108_864,
    expectedSizeBytes: 67_108_864,
    partCount: null,
    expiresAt: fixedExpiresAt,
    completedAt: null,
    abortedAt: null,
    expiredAt: null,
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

const searchPublicVideosResult = (): SearchPublicVideosResult => ({
  videos: [
    {
      publicId: 'AbCdEf123_',
      title: 'Me at the zoo',
      description: '00:00 Intro 00:05 The cool thing 00:17 End.',
      tags: ['zoo', 'elephants'],
      username: 'jawed',
      thumbnailPath: '/videos/AbCdEf123_/thumbnail',
      ratingAverage: 4.5,
      ratingCount: 2,
      publishedAt: fixedNow,
      createdAt: fixedNow,
    },
  ],
  total: 1,
  nextCursor: null,
});

const listPublicVideosResult = (): ListPublicVideosResult => ({
  videos: [
    {
      publicId: 'AbCdEf123_',
      title: 'Me at the zoo',
      createdAt: fixedNow,
      thumbnailPath: '/videos/AbCdEf123_/thumbnail',
      creator: {
        username: 'jawed',
        displayName: 'Jawed Karim',
      },
      viewCount: 128,
      duration: 19,
    },
  ],
  total: 1,
  nextCursor: null,
});

const getPublicVideoDetailResult = (): GetPublicVideoDetailResult => ({
  video: {
    publicId: 'AbCdEf123_',
    title: 'Me at the zoo',
    description: '00:00 Intro 00:05 The cool thing 00:17 End.',
    tags: ['zoo', 'elephants'],
    license: 'all_rights_reserved',
    visibility: 'public',
    createdAt: fixedNow,
    publishedAt: fixedNow,
    thumbnailPath: '/videos/AbCdEf123_/thumbnail',
    creator: {
      username: 'jawed',
      displayName: 'Jawed Karim',
      avatarUrl: '/profiles/jawed/avatar',
    },
    ratingAverage: 4.5,
    ratingCount: 2,
    userRating: null,
    viewCount: 128,
    duration: 19,
    hlsMasterPath: '/videos/AbCdEf123_/hls/master.m3u8',
  },
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
  listPublicVideos: async () => listPublicVideosResult(),
  searchPublicVideos: async () => searchPublicVideosResult(),
  getPublicVideoDetail: async () => getPublicVideoDetailResult(),
  getVideoRating: async () => ({
    ratingAverage: 4.5,
    ratingCount: 2,
  }),
  getMyVideoRating: async () => ({
    ratingAverage: 4.5,
    ratingCount: 2,
    userRating: 5,
  }),
  rateVideo: async (input) => ({
    ratingAverage: input.value,
    ratingCount: 1,
    userRating: input.value,
  }),
  getThumbnail: async () => ({
    url: 'http://localhost:9000/videos/thumbnail/poster.webp?signature=test',
  }),
  getHlsMaster: async ({ publicId }) => ({
    playlist: `#EXTM3U\n/videos/${publicId}/hls/test-generation/480p/index.m3u8\n`,
  }),
  getHlsRendition: async ({ generationId, publicId, quality }) => ({
    playlist: `#EXTM3U\n/videos/${publicId}/hls/${generationId}/${quality}/segments/segment-00000.ts\n`,
  }),
  getHlsSegment: async () => ({
    url: 'http://localhost:9000/videos/segment-00000.ts?signature=test',
  }),
  initMultipartUpload: async () => createUploadSessionResult(),
  uploadSourceThumbnail: async (input): Promise<UploadVideoSourceThumbnailResult> => ({
    thumbnail: {
      id: '44444444-4444-4444-8444-444444444444',
      uploadSessionId: input.uploadSessionId,
      mimeType: 'image/webp',
      sizeBytes: input.file.size,
      width: 1280,
      height: 720,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    },
  }),
  signMultipartUploadParts: async (input): Promise<SignVideoMultipartUploadPartsResult> => ({
    uploadSessionId: input.uploadSessionId,
    parts: input.partNumbers.map((partNumber) => ({
      partNumber,
      url: `http://localhost:9000/videos/user-id/video-id/sources/${input.uploadSessionId}/original.mp4?partNumber=${partNumber}&uploadId=test-upload-id`,
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
      status: 'aborting',
    }),
  getMultipartUploadSession: async () => createUploadSessionResult(),
});
