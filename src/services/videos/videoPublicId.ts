import { randomBytes } from 'node:crypto';

export const VIDEO_PUBLIC_ID_LENGTH = 10;
export const VIDEO_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_]{10}$/;

const VIDEO_PUBLIC_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
const MAX_UNBIASED_BYTE =
  Math.floor(256 / VIDEO_PUBLIC_ID_ALPHABET.length) * VIDEO_PUBLIC_ID_ALPHABET.length;

export type VideoPublicIdGenerator = {
  generate(): string;
};

export const createVideoPublicId = (): string => {
  let publicId = '';

  while (publicId.length < VIDEO_PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(VIDEO_PUBLIC_ID_LENGTH)) {
      if (byte >= MAX_UNBIASED_BYTE) {
        continue;
      }

      publicId += VIDEO_PUBLIC_ID_ALPHABET[byte % VIDEO_PUBLIC_ID_ALPHABET.length];

      if (publicId.length === VIDEO_PUBLIC_ID_LENGTH) {
        break;
      }
    }
  }

  return publicId;
};
