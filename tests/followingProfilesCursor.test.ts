import { describe, expect, test } from 'bun:test';
import { InvalidFollowingProfilesCursorError } from '../src/services/profiles.errors.js';
import { createFollowingProfilesCursorCodec } from '../src/services/profiles/followingProfilesCursor.js';

const cursor = {
  followedAt: new Date('2026-01-03T00:00:00.000Z'),
  id: '22222222-2222-4222-8222-222222222222',
};

describe('following profiles cursor codec', () => {
  test('round-trips the internal keyset boundary without exposing it', () => {
    const codec = createFollowingProfilesCursorCodec(Buffer.from('11'.repeat(32), 'hex'));
    const first = codec.encode(cursor);
    const second = codec.encode(cursor);

    expect(codec.decode(first)).toEqual(cursor);
    expect(codec.decode(second)).toEqual(cursor);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(first, 'base64url').toString('utf8')).not.toContain(cursor.id);
    expect(Buffer.from(first, 'base64url').toString('utf8')).not.toContain(
      cursor.followedAt.toISOString(),
    );
  });

  test('rejects tampered, truncated, non-canonical, and wrong-key cursors uniformly', () => {
    const codec = createFollowingProfilesCursorCodec(Buffer.from('11'.repeat(32), 'hex'));
    const wrongKeyCodec = createFollowingProfilesCursorCodec(Buffer.from('22'.repeat(32), 'hex'));
    const encoded = codec.encode(cursor);
    const replacement = encoded.endsWith('A') ? 'B' : 'A';
    const candidates = [
      `${encoded.slice(0, -1)}${replacement}`,
      encoded.slice(0, 20),
      `${encoded}=`,
      '',
    ];

    for (const candidate of candidates) {
      expect(() => codec.decode(candidate)).toThrow(InvalidFollowingProfilesCursorError);
    }

    expect(() => wrongKeyCodec.decode(encoded)).toThrow(InvalidFollowingProfilesCursorError);
  });

  test('refuses invalid internal cursor data before serialization', () => {
    const codec = createFollowingProfilesCursorCodec(Buffer.from('11'.repeat(32), 'hex'));

    expect(() => codec.encode({ ...cursor, id: 'not-a-uuid' })).toThrow(
      'Cannot encode an invalid following profiles cursor',
    );
    expect(() => codec.encode({ ...cursor, followedAt: new Date(Number.NaN) })).toThrow(
      'Cannot encode an invalid following profiles cursor',
    );
  });
});
