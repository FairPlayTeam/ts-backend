// Keep direct uploads below Cloudflare's 100MB request cap.
export const DIRECT_VIDEO_UPLOAD_MAX_BYTES = 95 * 1024 * 1024;
export const DIRECT_VIDEO_UPLOAD_MAX_MB = Math.round(
  DIRECT_VIDEO_UPLOAD_MAX_BYTES / (1024 * 1024),
);

export const VIDEO_CHUNK_BYTES = 95 * 1024 * 1024;
export const VIDEO_CHUNK_MB = Math.round(VIDEO_CHUNK_BYTES / (1024 * 1024));
export const MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS = 32;
export const MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES =
  VIDEO_CHUNK_BYTES * MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS;
export const MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB = Math.round(
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES / (1024 * 1024),
);

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_UPLOAD_MB = Math.round(
  MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024),
);

export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
export const MAX_THUMBNAIL_MB = Math.round(
  MAX_THUMBNAIL_BYTES / (1024 * 1024),
);

export const getRequiredVideoChunkCount = (totalSize: number): number =>
  Math.ceil(totalSize / VIDEO_CHUNK_BYTES);

export const validateChunkedVideoUploadPlan = (
  totalSize: number,
  totalChunks: number,
): string | null => {
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    return 'totalSize must be a positive integer';
  }

  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    return 'totalChunks must be a positive integer';
  }

  if (totalSize > MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES) {
    return `Chunked uploads are limited to ${MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB}MB total`;
  }

  if (totalChunks > MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS) {
    return `Chunked uploads are limited to ${MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS} chunks`;
  }

  const requiredChunks = getRequiredVideoChunkCount(totalSize);

  if (totalChunks !== requiredChunks) {
    return `Invalid totalChunks for ${VIDEO_CHUNK_MB}MB chunks. Expected ${requiredChunks} chunk(s) for totalSize ${totalSize}`;
  }

  return null;
};
