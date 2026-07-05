import { z } from '../../docs/zod.js';
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '../../config/constants.js';

export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_]+$/, 'Username may only contain letters, numbers, and underscores')
  .transform((value) => value.toLowerCase())
  .openapi({ example: 'fairplay_creator' });
