import { describe, expect, test } from 'bun:test';
import { toVideosHttpError } from '../src/controllers/videos.errors.js';
import { rateVideoBodySchema } from '../src/controllers/videos.schemas.js';
import { HttpError } from '../src/errors/http.js';
import { VideoRatingTemporarilyUnavailableError } from '../src/services/videos.errors.js';
import {
  calculateVideoRatingAverage,
  getVideoRatingRetryDelayMs,
} from '../src/services/videos/videoRating.js';

describe('video ratings', () => {
  test('accepts only integer star values from 1 through 5', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expect(rateVideoBodySchema.safeParse({ value }).success).toBe(true);
    }

    for (const value of [0, 6, 2.5, '5']) {
      expect(rateVideoBodySchema.safeParse({ value }).success).toBe(false);
    }
  });

  test('calculates the average from the exact sum and rounds to one decimal place', () => {
    expect(calculateVideoRatingAverage(0, 0)).toBe(0);
    expect(calculateVideoRatingAverage(9, 2)).toBe(4.5);
    expect(calculateVideoRatingAverage(10, 3)).toBe(3.3);
  });

  test('uses capped exponential full jitter for contention retries', () => {
    expect(getVideoRatingRetryDelayMs(1, () => 0)).toBe(0);
    expect(getVideoRatingRetryDelayMs(1, () => 0.999)).toBe(5);
    expect(getVideoRatingRetryDelayMs(2, () => 0.999)).toBe(10);
    expect(getVideoRatingRetryDelayMs(6, () => 0.999)).toBe(160);
    expect(getVideoRatingRetryDelayMs(7, () => 0.999)).toBe(250);
    expect(getVideoRatingRetryDelayMs(20, () => 0.999)).toBe(250);
  });

  test('maps exhausted rating contention to service unavailable', () => {
    const cause = new Error('transaction conflict');
    const error = toVideosHttpError(new VideoRatingTemporarilyUnavailableError({ cause }));

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(503);
    expect((error as HttpError).code).toBe('ServiceUnavailable');
    expect(error.cause).toBeInstanceOf(VideoRatingTemporarilyUnavailableError);
  });
});
