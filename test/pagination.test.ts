import { describe, expect, it } from 'bun:test';
import { parsePagination } from '../src/lib/pagination.js';

describe('parsePagination', () => {
  it('returns the configured defaults when query params are missing', () => {
    expect(parsePagination({}, { defaultLimit: 25, maxLimit: 50 })).toEqual({
      page: 1,
      limit: 25,
      skip: 0,
    });
  });

  it('clamps invalid values and caps the maximum limit', () => {
    expect(
      parsePagination(
        { page: '-4', limit: '500' },
        { defaultLimit: 20, maxLimit: 50 },
      ),
    ).toEqual({
      page: 1,
      limit: 50,
      skip: 0,
    });
  });

  it('accepts array-like query values from Express and computes skip', () => {
    expect(
      parsePagination(
        { page: ['3'], limit: ['15'] },
        { defaultLimit: 20, maxLimit: 50 },
      ),
    ).toEqual({
      page: 3,
      limit: 15,
      skip: 30,
    });
  });
});
