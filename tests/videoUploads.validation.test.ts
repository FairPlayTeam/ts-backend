import { describe, expect, test } from 'bun:test';
import { completeVideoMultipartUploadBodySchema } from '../src/modules/videoUploads/http/schemas.js';
import { isXmlCompatibleUploadETag } from '../src/modules/videoUploads/validation.js';

describe('multipart ETag XML compatibility', () => {
  test('rejects forbidden XML characters on the original JSON string, including before trimming', () => {
    const controls = Array.from({ length: 32 }, (_, index) => index)
      .filter((code) => ![9, 10, 13].includes(code))
      .map((code) => String.fromCodePoint(code));
    for (const character of [...controls, '\ufffe', '\uffff', '\ud800', '\udfff']) {
      for (const etag of [character, `${character}opaque`, `opaque${character}`]) {
        expect(isXmlCompatibleUploadETag(etag)).toBe(false);
        expect(
          completeVideoMultipartUploadBodySchema.safeParse({ parts: [{ partNumber: 1, etag }] })
            .success,
        ).toBe(false);
      }
    }
  });

  test('retains opaque non-MD5 ETags, XML punctuation and valid Unicode scalar values', () => {
    for (const etag of [
      'opaque-multipart-7',
      'a&<>"\'b',
      'a]]>b',
      'été 🗿',
      'a\t\r\nb',
      '\u007f',
      '\u0085',
      '\ud7ff',
      '\ue000',
      '\ufffd',
      '\u{10000}',
      '\u{10ffff}',
    ]) {
      expect(isXmlCompatibleUploadETag(etag)).toBe(true);
      expect(
        completeVideoMultipartUploadBodySchema.parse({ parts: [{ partNumber: 1, etag }] }),
      ).toEqual({ parts: [{ partNumber: 1, etag }] });
    }
  });
});
