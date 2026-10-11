import { toIsoString, toNullableIsoString } from '../../../controllers/http.responses.js';
import type {
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailResult,
  VideoSourceThumbnail,
  VideoUploadPart,
  VideoUploadSession,
  VideoUploadSessionResult,
} from '../types.js';

type VideoUploadSessionResponse = {
  uploadSession: Pick<
    VideoUploadSession,
    'id' | 'videoId' | 'status' | 'partSizeBytes' | 'expectedSizeBytes' | 'partCount'
  > & {
    expiresAt: string;
    completedAt: string | null;
    abortedAt: string | null;
    expiredAt: string | null;
    createdAt: string;
    updatedAt: string;
    parts: (Pick<VideoUploadPart, 'partNumber' | 'etag' | 'sizeBytes'> & {
      createdAt: string;
    })[];
  };
};

type SignedVideoUploadPartsResponse = {
  uploadSessionId: string;
  parts: {
    partNumber: number;
    url: string;
  }[];
};

type UploadVideoSourceThumbnailResponse = {
  thumbnail: Pick<
    VideoSourceThumbnail,
    'uploadSessionId' | 'mimeType' | 'sizeBytes' | 'width' | 'height'
  > & {
    createdAt: string;
    updatedAt: string;
  };
};

export const toVideoUploadSessionResponse = ({
  uploadSession,
}: VideoUploadSessionResult): VideoUploadSessionResponse => ({
  uploadSession: {
    id: uploadSession.id,
    videoId: uploadSession.videoId,
    status: uploadSession.status,
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

export const toSignedVideoUploadPartsResponse = (
  result: SignVideoMultipartUploadPartsResult,
): SignedVideoUploadPartsResponse => ({
  uploadSessionId: result.uploadSessionId,
  parts: result.parts,
});

export const toUploadVideoSourceThumbnailResponse = ({
  thumbnail,
}: UploadVideoSourceThumbnailResult): UploadVideoSourceThumbnailResponse => ({
  thumbnail: {
    uploadSessionId: thumbnail.uploadSessionId,
    mimeType: thumbnail.mimeType,
    sizeBytes: thumbnail.sizeBytes,
    width: thumbnail.width,
    height: thumbnail.height,
    createdAt: toIsoString(thumbnail.createdAt),
    updatedAt: toIsoString(thumbnail.updatedAt),
  },
});
