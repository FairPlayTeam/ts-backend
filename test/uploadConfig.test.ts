import { describe, expect, it } from 'bun:test';
import {
  MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS,
  MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES,
  VIDEO_CHUNK_BYTES,
  getRequiredVideoChunkCount,
  validateChunkedVideoUploadPlan,
} from '../src/lib/uploadConfig.js';

describe('getRequiredVideoChunkCount', () => {
  it('rounds up to the number of fixed-size chunks required', () => {
    expect(getRequiredVideoChunkCount(1)).toBe(1);
    expect(getRequiredVideoChunkCount(VIDEO_CHUNK_BYTES)).toBe(1);
    expect(getRequiredVideoChunkCount(VIDEO_CHUNK_BYTES + 1)).toBe(2);
  });
});

describe('validateChunkedVideoUploadPlan', () => {
  it('accepts plans that fit the configured fixed chunk size', () => {
    expect(
      validateChunkedVideoUploadPlan(VIDEO_CHUNK_BYTES * 2 + 123, 3),
    ).toBeNull();
  });

  it('rejects uploads that exceed the total size or chunk count caps', () => {
    expect(
      validateChunkedVideoUploadPlan(
        MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES + 1,
        MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS,
      ),
    ).toContain('limited');

    expect(
      validateChunkedVideoUploadPlan(
        MAX_CHUNKED_VIDEO_UPLOAD_TOTAL_BYTES,
        MAX_CHUNKED_VIDEO_UPLOAD_CHUNKS + 1,
      ),
    ).toContain('limited');
  });

  it('rejects inconsistent totalSize and totalChunks combinations', () => {
    expect(
      validateChunkedVideoUploadPlan(VIDEO_CHUNK_BYTES + 1, 1),
    ).toContain('Invalid totalChunks');
    expect(validateChunkedVideoUploadPlan(0, 1)).toContain('positive integer');
    expect(validateChunkedVideoUploadPlan(1, 0)).toContain('positive integer');
  });
});
