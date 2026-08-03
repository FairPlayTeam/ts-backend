import { z } from '../../docs/zod.js';

export const relativeAssetPathSchema = z
  .string()
  .regex(/^\/(?!\/)[^\s]*$/, 'Asset path must be a relative same-origin path');
