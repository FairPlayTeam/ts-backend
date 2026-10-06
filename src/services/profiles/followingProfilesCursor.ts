import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from 'node:crypto';
import { InvalidFollowingProfilesCursorError } from '../profiles.errors.js';

export const FOLLOWING_PROFILES_CURSOR_MAX_LENGTH = 512;

const ALGORITHM = 'aes-256-gcm' satisfies CipherGCMTypes;
const AUTH_TAG_BYTES = 16;
const CURSOR_VERSION = 1;
const INITIALIZATION_VECTOR_BYTES = 12;
const KEY_BYTES = 32;
const CURSOR_AAD = Buffer.from('fairplay:following-profiles-cursor:v1', 'utf8');
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type FollowingProfilesCursor = {
  followedAt: Date;
  id: string;
};

export type FollowingProfilesCursorCodec = {
  decode(value: string): FollowingProfilesCursor;
  encode(cursor: FollowingProfilesCursor): string;
};

type SerializedFollowingProfilesCursor = {
  followedAt: string;
  id: string;
};

const isSerializedFollowingProfilesCursor = (
  value: unknown,
): value is SerializedFollowingProfilesCursor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);

  if (
    keys.length !== 2 ||
    !keys.includes('followedAt') ||
    !keys.includes('id') ||
    !('followedAt' in value) ||
    !('id' in value)
  ) {
    return false;
  }

  return typeof value.followedAt === 'string' && typeof value.id === 'string';
};

const parseSerializedCursor = (plaintext: Buffer): FollowingProfilesCursor => {
  const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

  if (!isSerializedFollowingProfilesCursor(parsed) || !UUID_PATTERN.test(parsed.id)) {
    throw new InvalidFollowingProfilesCursorError();
  }

  const followedAt = new Date(parsed.followedAt);

  if (!Number.isFinite(followedAt.getTime()) || followedAt.toISOString() !== parsed.followedAt) {
    throw new InvalidFollowingProfilesCursorError();
  }

  return {
    followedAt,
    id: parsed.id,
  };
};

export const createFollowingProfilesCursorCodec = (
  encryptionKey: Buffer,
): FollowingProfilesCursorCodec => {
  if (encryptionKey.length !== KEY_BYTES) {
    throw new Error(`Following profiles cursor encryption key must be ${KEY_BYTES} bytes`);
  }

  return {
    decode(value) {
      try {
        if (
          value.length === 0 ||
          value.length > FOLLOWING_PROFILES_CURSOR_MAX_LENGTH ||
          !BASE64URL_PATTERN.test(value)
        ) {
          throw new InvalidFollowingProfilesCursorError();
        }

        const envelope = Buffer.from(value, 'base64url');

        if (
          envelope.toString('base64url') !== value ||
          envelope.length <= 1 + INITIALIZATION_VECTOR_BYTES + AUTH_TAG_BYTES ||
          envelope[0] !== CURSOR_VERSION
        ) {
          throw new InvalidFollowingProfilesCursorError();
        }

        const initializationVector = envelope.subarray(1, 1 + INITIALIZATION_VECTOR_BYTES);
        const authTag = envelope.subarray(
          1 + INITIALIZATION_VECTOR_BYTES,
          1 + INITIALIZATION_VECTOR_BYTES + AUTH_TAG_BYTES,
        );
        const ciphertext = envelope.subarray(1 + INITIALIZATION_VECTOR_BYTES + AUTH_TAG_BYTES);
        const decipher = createDecipheriv(ALGORITHM, encryptionKey, initializationVector);
        decipher.setAAD(CURSOR_AAD);
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return parseSerializedCursor(plaintext);
      } catch (error) {
        if (error instanceof InvalidFollowingProfilesCursorError) {
          throw error;
        }

        throw new InvalidFollowingProfilesCursorError();
      }
    },

    encode({ followedAt, id }) {
      if (!Number.isFinite(followedAt.getTime()) || !UUID_PATTERN.test(id)) {
        throw new Error('Cannot encode an invalid following profiles cursor');
      }

      const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
      const cipher = createCipheriv(ALGORITHM, encryptionKey, initializationVector);
      cipher.setAAD(CURSOR_AAD);
      const plaintext = Buffer.from(
        JSON.stringify({
          followedAt: followedAt.toISOString(),
          id,
        } satisfies SerializedFollowingProfilesCursor),
        'utf8',
      );
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = Buffer.concat([
        Buffer.from([CURSOR_VERSION]),
        initializationVector,
        cipher.getAuthTag(),
        ciphertext,
      ]);
      const token = envelope.toString('base64url');

      if (token.length > FOLLOWING_PROFILES_CURSOR_MAX_LENGTH) {
        throw new Error('Encoded following profiles cursor exceeds its public size limit');
      }

      return token;
    },
  };
};
