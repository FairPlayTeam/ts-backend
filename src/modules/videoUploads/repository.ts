import { Prisma } from '@prisma/client';

// Read mutable session authorization and time only after acquiring this lock.
export const lockUploadSession = async (
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  id: string,
): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "video_upload_sessions"
    WHERE "id" = CAST(${id} AS UUID)
    FOR UPDATE
  `);
};

export const uploadSessionSelect = {
  id: true,
  videoId: true,
  userId: true,
  status: true,
  bucket: true,
  objectKey: true,
  partSizeBytes: true,
  expectedSizeBytes: true,
  partCount: true,
  expiresAt: true,
  hardExpiresAt: true,
  verifiedUploadedBytes: true,
  nextProgressCheckAt: true,
  completedAt: true,
  abortedAt: true,
  expiredAt: true,
  externalResourceTargetId: true,
  externalResourceTarget: { select: { goal: true } },
  createdAt: true,
  updatedAt: true,
  multipartHandle: {
    select: {
      uploadId: true,
    },
  },
  sourceThumbnail: {
    select: {
      bucket: true,
      externalResourceTargetId: true,
      mimeType: true,
      objectKey: true,
      sizeBytes: true,
      width: true,
      height: true,
      externalResourceTarget: {
        select: {
          bucket: true,
          expectedSizeBytes: true,
          generation: true,
          goal: true,
          role: true,
          selector: true,
          selectorKind: true,
          state: true,
          userId: true,
          videoId: true,
        },
      },
    },
  },
  parts: {
    select: {
      partNumber: true,
      etag: true,
      sizeBytes: true,
      createdAt: true,
    },
    orderBy: {
      partNumber: 'asc',
    },
  },
} satisfies Prisma.VideoUploadSessionSelect;

export const sourceThumbnailSelect = {
  uploadSessionId: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VideoSourceThumbnailSelect;

export const completedSourceSessionSelect = {
  id: true,
  userId: true,
  videoId: true,
  status: true,
  sourceThumbnail: uploadSessionSelect.sourceThumbnail,
  _count: {
    select: {
      parts: true,
    },
  },
} satisfies Prisma.VideoUploadSessionSelect;

export const reconciliationUploadSessionSelect = {
  id: true,
  videoId: true,
  userId: true,
  status: true,
  bucket: true,
  objectKey: true,
  externalResourceTargetId: true,
  multipartHandle: {
    select: {
      uploadId: true,
    },
  },
  parts: {
    select: {
      partNumber: true,
      etag: true,
    },
    orderBy: {
      partNumber: 'asc',
    },
  },
} satisfies Prisma.VideoUploadSessionSelect;

export type UploadSessionRecord = Prisma.VideoUploadSessionGetPayload<{
  select: typeof uploadSessionSelect;
}>;

export type ReconciliationUploadSessionRecord = Prisma.VideoUploadSessionGetPayload<{
  select: typeof reconciliationUploadSessionSelect;
}>;
