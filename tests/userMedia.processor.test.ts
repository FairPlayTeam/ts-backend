import { describe, expect, test } from 'bun:test';
import sharp from '../src/lib/sharp.js';
import { createUserMediaProcessor } from '../src/services/userMedia/userMedia.processor.js';
import {
  UserMediaFileTooLargeError,
  UserMediaInvalidImageError,
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

const createImage = async (
  format: 'jpeg' | 'png' | 'webp',
  width = 800,
  height = 600,
): Promise<Buffer> => {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#3388ff',
    },
  });

  switch (format) {
    case 'jpeg':
      return image.jpeg().toBuffer();
    case 'png':
      return image.png().toBuffer();
    case 'webp':
      return image.webp().toBuffer();
  }
};

describe('user media processor', () => {
  test('normalizes avatar uploads to a square WebP without metadata', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
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

  test('normalizes banner uploads to a wide WebP without metadata', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });
    const input = await createPng(2400, 1200);

    const result = await processor.process({
      kind: 'banner',
      file: {
        buffer: input,
        size: input.length,
      },
    });

    expect(result.mimeType).toBe('image/webp');
    expect(result.sizeBytes).toBe(result.buffer.length);
    expect(result.width).toBe(1500);
    expect(result.height).toBe(500);

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(1500);
    expect(metadata.height).toBe(500);
    expect(metadata.exif).toBeUndefined();
  });

  test('center-crops video thumbnails from common source ratios to an exact 1280x720 WebP', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });

    for (const [width, height] of [
      [600, 1200],
      [900, 900],
      [1600, 900],
      [2400, 600],
    ]) {
      const input = await createPng(width, height);
      const result = await processor.processVideoThumbnail({
        buffer: input,
        size: input.length,
      });
      const metadata = await sharp(result.buffer).metadata();

      expect(result.mimeType).toBe('image/webp');
      expect(result.width).toBe(1280);
      expect(result.height).toBe(720);
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBe(1280);
      expect(metadata.height).toBe(720);
      expect(metadata.exif).toBeUndefined();
    }
  });

  test('explicitly enlarges a small video thumbnail to the fixed 1280x720 contract', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });
    const input = await createPng(160, 90);
    const result = await processor.processVideoThumbnail({
      buffer: input,
      size: input.length,
    });

    await expect(sharp(result.buffer).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 1280,
      height: 720,
    });
  });

  test('rotates EXIF pixels before applying the centered 16:9 crop', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });
    const upright = Buffer.from(`
      <svg width="1600" height="1200" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="left" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#0044ff"/>
            <stop offset="1" stop-color="#00ffff"/>
          </linearGradient>
          <pattern id="right" width="80" height="80" patternUnits="userSpaceOnUse">
            <rect width="80" height="80" fill="#ff8800"/>
            <circle cx="40" cy="40" r="18" fill="#ffff00"/>
          </pattern>
        </defs>
        <rect width="1600" height="150" fill="#ff0033"/>
        <rect y="150" width="800" height="900" fill="url(#left)"/>
        <rect x="800" y="150" width="800" height="900" fill="url(#right)"/>
        <path d="M650 600 L800 400 L950 600 L800 800 Z" fill="#9900cc"/>
        <rect y="1050" width="1600" height="150" fill="#00aa33"/>
      </svg>
    `);
    const physicallyRotated = await sharp(upright)
      .rotate(270)
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const result = await processor.processVideoThumbnail({
      buffer: physicallyRotated,
      size: physicallyRotated.length,
    });
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number): readonly number[] => {
      const offset = (y * info.width + x) * info.channels;

      return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
    };

    expect(info).toMatchObject({
      channels: 3,
      width: 1280,
      height: 720,
    });
    expect(pixel(80, 360)[2]).toBeGreaterThan(pixel(80, 360)[0] ?? 0);
    expect(pixel(1200, 360)[0]).toBeGreaterThan(pixel(1200, 360)[2] ?? 0);
    expect(pixel(640, 360)[0]).toBeGreaterThan(pixel(640, 360)[1] ?? 0);
    expect(pixel(640, 360)[2]).toBeGreaterThan(pixel(640, 360)[1] ?? 0);
  });

  test('rejects a highly compressed image declaring more than 16 million pixels', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });
    const compressedPixelBomb = await createPng(5_000, 4_000);

    expect(compressedPixelBomb.length).toBeLessThan(3 * 1024 * 1024);
    await expect(
      processor.processVideoThumbnail({
        buffer: compressedPixelBomb,
        size: compressedPixelBomb.length,
      }),
    ).rejects.toBeInstanceOf(UserMediaInvalidImageError);
  });

  test('accepts JPEG, PNG, and WebP video thumbnails by file signature', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
    });

    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const input = await createImage(format);

      await expect(
        processor.processVideoThumbnail({
          buffer: input,
          size: input.length,
        }),
      ).resolves.toMatchObject({
        mimeType: 'image/webp',
        width: 1280,
        height: 720,
      });
    }
  });

  test('rejects unsupported file signatures', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 3 * 1024 * 1024,
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

    await expect(
      processor.processVideoThumbnail({
        buffer: Buffer.from('not an image'),
        size: 12,
      }),
    ).rejects.toBeInstanceOf(UserMediaUnsupportedTypeError);
  });

  test('rejects files larger than the media policy allows', async () => {
    const processor = createUserMediaProcessor({
      profileMediaMaxUploadBytes: 4,
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

    await expect(
      processor.process({
        kind: 'banner',
        file: {
          buffer: input,
          size: input.length,
        },
      }),
    ).rejects.toBeInstanceOf(UserMediaFileTooLargeError);

    await expect(
      processor.processVideoThumbnail({
        buffer: input,
        size: input.length,
      }),
    ).rejects.toBeInstanceOf(UserMediaFileTooLargeError);
  });
});
