import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { createUserMediaProcessor } from '../src/services/userMedia/userMedia.processor.js';
import {
  UserMediaFileTooLargeError,
  UserMediaUnsupportedTypeError,
} from '../src/services/userMedia/userMedia.errors.js';

const createPng = async (width = 800, height = 600): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#3388ff',
    },
  })
    .png()
    .toBuffer();

describe('user media processor', () => {
  test('normalizes avatar uploads to a square WebP without metadata', async () => {
    const processor = createUserMediaProcessor({
      avatarMaxUploadBytes: 3 * 1024 * 1024,
    });
    const input = await createPng();

    const result = await processor.process({
      kind: 'avatar',
      file: {
        buffer: input,
        size: input.length,
      },
    });

    expect(result.mimeType).toBe('image/webp');
    expect(result.sizeBytes).toBe(result.buffer.length);
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(metadata.exif).toBeUndefined();
  });

  test('rejects unsupported file signatures', async () => {
    const processor = createUserMediaProcessor({
      avatarMaxUploadBytes: 3 * 1024 * 1024,
    });

    await expect(
      processor.process({
        kind: 'avatar',
        file: {
          buffer: Buffer.from('not an image'),
          size: 12,
        },
      }),
    ).rejects.toBeInstanceOf(UserMediaUnsupportedTypeError);
  });

  test('rejects files larger than the media policy allows', async () => {
    const processor = createUserMediaProcessor({
      avatarMaxUploadBytes: 4,
    });
    const input = await createPng(16, 16);

    await expect(
      processor.process({
        kind: 'avatar',
        file: {
          buffer: input,
          size: input.length,
        },
      }),
    ).rejects.toBeInstanceOf(UserMediaFileTooLargeError);
  });
});
