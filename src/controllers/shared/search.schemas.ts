import { z } from '../../docs/zod.js';

export const VIDEO_SEARCH_MAX_LENGTH = 254;
export const VIDEO_SEARCH_MIN_LENGTH = 2;

const createVideoSearchTextSchema = (minimumLength?: number) => {
  const textSchema = z.string().trim();
  const lengthSchema =
    minimumLength === undefined
      ? textSchema
      : textSchema.min(minimumLength, `Video search must be at least ${minimumLength} characters`);

  return lengthSchema
    .max(
      VIDEO_SEARCH_MAX_LENGTH,
      `Video search must be at most ${VIDEO_SEARCH_MAX_LENGTH} characters`,
    )
    .refine((search) => !search.includes('\u0000'), {
      message: 'Video search must not contain NUL characters',
    });
};

export const videoSearchTextSchema = createVideoSearchTextSchema();
export const publicVideoSearchTextSchema = createVideoSearchTextSchema(VIDEO_SEARCH_MIN_LENGTH);
