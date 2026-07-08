import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type {
  CreateVideoResult,
  SignVideoMultipartUploadPartsResult,
  VideoUploadSessionResult,
} from '../../services/videos.types.js';

export const toCreateVideoResponse = ({ video }: CreateVideoResult) => ({
  video: {
    ...video,
    createdAt: toIsoString(video.createdAt),
    updatedAt: toIsoString(video.updatedAt),
  },
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
    partCount: uploadSession.partCount,
    expiresAt: toIsoString(uploadSession.expiresAt),
    completedAt: toNullableIsoString(uploadSession.completedAt),
    abortedAt: toNullableIsoString(uploadSession.abortedAt),
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
