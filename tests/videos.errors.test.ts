import { describe, expect, test } from 'bun:test';
import { HttpError } from '../src/errors/http.js';
import {
  VideoTranscodeAdmissionFullError,
  VideoUploadSessionNotFoundError,
} from '../src/modules/videoUploads/errors.js';
import { toVideoUploadsHttpError } from '../src/modules/videoUploads/http/errorMapper.js';
import { VideoNotFoundError } from '../src/services/videos.errors.js';

describe('video uploads error mapping', () => {
  test('maps transcode admission rejection to one generic retryable response', () => {
    const mapped = toVideoUploadsHttpError(new VideoTranscodeAdmissionFullError());

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

  test('maps a missing video and an inaccessible upload session to the same 404', () => {
    const missingVideo = toVideoUploadsHttpError(new VideoNotFoundError());
    const missingSession = toVideoUploadsHttpError(new VideoUploadSessionNotFoundError());

    expect(missingVideo).toBeInstanceOf(HttpError);
    expect(missingSession).toBeInstanceOf(HttpError);

    if (!(missingVideo instanceof HttpError) || !(missingSession instanceof HttpError)) {
      throw new Error('Expected uniform upload not-found HTTP errors');
    }

    const publicError = (error: HttpError) => ({
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    });

    expect(publicError(missingVideo)).toEqual(publicError(missingSession));
  });
});
