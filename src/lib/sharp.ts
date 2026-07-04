import sharp from 'sharp';
import { parseOptionalSharpConcurrency, SHARP_CONCURRENCY_ENV } from './sharpConcurrency.js';

const configuredSharpConcurrency = parseOptionalSharpConcurrency(
  process.env[SHARP_CONCURRENCY_ENV],
);

if (configuredSharpConcurrency !== undefined) {
  sharp.concurrency(configuredSharpConcurrency);
}

export default sharp;
