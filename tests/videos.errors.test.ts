import { describe, expect, test } from 'bun:test';
import { HttpError } from '../src/errors/http.js';
import { VideoTranscodeAdmissionFullError } from '../src/services/videos.errors.js';
import { toVideosHttpError } from '../src/controllers/videos.errors.js';

describe('video error mapping', () => {
  test('maps transcode admission rejection to one generic retryable response', () => {
    const mapped = toVideosHttpError(new VideoTranscodeAdmissionFullError());

    expect(mapped).toBeInstanceOf(HttpError);

    if (!(mapped instanceof HttpError)) {
      throw new Error('Expected an HTTP error');
    }

    expect(mapped.statusCode).toBe(429);
    expect(mapped.code).toBe('TooManyRequests');
    expect(mapped.message).toBe(
      'Video processing capacity is temporarily full; please retry later',
    );
  });
});
