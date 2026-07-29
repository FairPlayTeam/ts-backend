import { describe, expect, test } from 'bun:test';
import {
  buildVideoSearchFilter,
  escapeVideoSearchTermForIlike,
} from '../src/services/videos/videoSearch.js';

describe('video search filter', () => {
  test('escapes every ILIKE wildcard as literal text, including adversarial combinations', () => {
    const cases = [
      { input: '%', expected: String.raw`\%` },
      { input: '_', expected: String.raw`\_` },
      { input: String.raw`\%`, expected: String.raw`\\\%` },
      {
        input: String.raw`50%_off\sale`,
        expected: String.raw`50\%\_off\\sale`,
      },
    ] as const;

    for (const { expected, input } of cases) {
      expect(escapeVideoSearchTermForIlike(input)).toBe(expected);
      expect(() => buildVideoSearchFilter(input)).not.toThrow();
      expect(buildVideoSearchFilter(input)).toEqual({
        OR: [
          { title: { contains: expected, mode: 'insensitive' } },
          { description: { contains: expected, mode: 'insensitive' } },
          { tags: { has: input } },
        ],
      });
    }

    expect(buildVideoSearchFilter('%')).not.toEqual({
      OR: [
        { title: { contains: '%', mode: 'insensitive' } },
        { description: { contains: '%', mode: 'insensitive' } },
        { tags: { has: '%' } },
      ],
    });
  });

  test('normalizes surrounding whitespace and searches exact tags', () => {
    expect(buildVideoSearchFilter('  Launch recap  ')).toEqual({
      OR: [
        { title: { contains: 'Launch recap', mode: 'insensitive' } },
        { description: { contains: 'Launch recap', mode: 'insensitive' } },
        { tags: { has: 'Launch recap' } },
      ],
    });
    expect(buildVideoSearchFilter('   ')).toBeUndefined();
    expect(buildVideoSearchFilter(undefined)).toBeUndefined();
  });
});
