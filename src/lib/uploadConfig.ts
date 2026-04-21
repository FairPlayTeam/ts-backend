const MEBIBYTE = 1024 * 1024;

// Keep direct video-only uploads below Cloudflare's 100MB request cap.
export const DIRECT_VIDEO_UPLOAD_MAX_BYTES = 95 * MEBIBYTE;
export const DIRECT_VIDEO_UPLOAD_MAX_MB = Math.round(
  DIRECT_VIDEO_UPLOAD_MAX_BYTES / MEBIBYTE,
);

// Keep bundled direct uploads lower to leave room for thumbnails and multipart overhead.
export const DIRECT_VIDEO_BUNDLE_MAX_BYTES = 90 * MEBIBYTE;
export const DIRECT_VIDEO_BUNDLE_MAX_MB = Math.round(
  DIRECT_VIDEO_BUNDLE_MAX_BYTES / MEBIBYTE,
);

export const VIDEO_CHUNK_BYTES = 24 * MEBIBYTE;
export const VIDEO_CHUNK_MB = Math.round(VIDEO_CHUNK_BYTES / MEBIBYTE);
export const VIDEO_CHUNK_REQUEST_MAX_BYTES = VIDEO_CHUNK_BYTES + (1 * MEBIBYTE);
export const MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES = 3040 * MEBIBYTE;
export const MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS = Math.ceil(
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES / VIDEO_CHUNK_BYTES,
);
export const MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_MB = Math.round(
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES / MEBIBYTE,
);

export const MAX_IMAGE_UPLOAD_BYTES = 10 * MEBIBYTE;
export const MAX_IMAGE_UPLOAD_MB = Math.round(
  MAX_IMAGE_UPLOAD_BYTES / MEBIBYTE,
);

export const MAX_THUMBNAIL_BYTES = 5 * MEBIBYTE;
export const MAX_THUMBNAIL_MB = Math.round(
  MAX_THUMBNAIL_BYTES / MEBIBYTE,
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
