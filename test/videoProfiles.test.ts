import { describe, expect, it } from 'bun:test';
import {
  VIDEO_QUALITIES,
  selectQualitiesForSource,
} from '../src/lib/videoProfiles.js';

describe('selectQualitiesForSource', () => {
  it('returns every quality that fits inside the source height', () => {
    expect(selectQualitiesForSource(720).map((quality) => quality.name)).toEqual([
      '240p',
      '480p',
      '720p',
    ]);
  });

  it('falls back to the smallest configured quality for very small sources', () => {
    expect(selectQualitiesForSource(144).map((quality) => quality.name)).toEqual([
      VIDEO_QUALITIES[0].name,
    ]);
  });

  it('returns no qualities for invalid source heights', () => {
    expect(selectQualitiesForSource(0)).toEqual([]);
  });
});
