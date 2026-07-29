import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type {
  CreateVideoResult,
  ListMyVideosResult,
  SearchPublicVideosResult,
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailResult,
  VideoUploadSessionResult,
} from '../../services/videos.types.js';

const toVideoResponse = (video: CreateVideoResult['video']) => ({
  ...video,
  createdAt: toIsoString(video.createdAt),
  updatedAt: toIsoString(video.updatedAt),
});

export const toCreateVideoResponse = ({ video }: CreateVideoResult) => ({
  video: toVideoResponse(video),
});

export const toMyVideosResponse = ({ nextCursor, total, videos }: ListMyVideosResult) => ({
  videos: videos.map((video) => toVideoResponse(video)),
  total,
  nextCursor: nextCursor
    ? {
        id: nextCursor.id,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toPublicVideoSearchResponse = ({
  nextCursor,
  total,
  videos,
}: SearchPublicVideosResult) => ({
  videos: videos.map((video) => ({
    ...video,
    publishedAt: toNullableIsoString(video.publishedAt),
    createdAt: toIsoString(video.createdAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        publicId: nextCursor.publicId,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toVideoUploadSessionResponse = ({ uploadSession }: VideoUploadSessionResult) => ({
  uploadSession: {
    id: uploadSession.id,
    videoId: uploadSession.videoId,
    status: uploadSession.status,
    bucket: uploadSession.bucket,
    objectKey: uploadSession.objectKey,
    uploadId: uploadSession.uploadId,
    partSizeBytes: uploadSession.partSizeBytes,
    expectedSizeBytes: uploadSession.expectedSizeBytes,
    partCount: uploadSession.partCount,
    expiresAt: toIsoString(uploadSession.expiresAt),
    completedAt: toNullableIsoString(uploadSession.completedAt),
    abortedAt: toNullableIsoString(uploadSession.abortedAt),
    expiredAt: toNullableIsoString(uploadSession.expiredAt),
    createdAt: toIsoString(uploadSession.createdAt),
    updatedAt: toIsoString(uploadSession.updatedAt),
    parts: uploadSession.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      sizeBytes: part.sizeBytes,
      createdAt: toIsoString(part.createdAt),
    })),
  },
});

export const toSignedVideoUploadPartsResponse = (result: SignVideoMultipartUploadPartsResult) => ({
  uploadSessionId: result.uploadSessionId,
  parts: result.parts,
});

export const toUploadVideoSourceThumbnailResponse = ({
  thumbnail,
}: UploadVideoSourceThumbnailResult) => ({
  thumbnail: {
    ...thumbnail,
    createdAt: toIsoString(thumbnail.createdAt),
    updatedAt: toIsoString(thumbnail.updatedAt),
  },
});
