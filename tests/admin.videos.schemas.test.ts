import { describe, expect, test } from 'bun:test';
import { moderateAdminVideoRequestSchema } from '../src/controllers/admin/schemas/videos.schemas.js';
import { VIDEO_REJECTION_REASON_MAX_LENGTH } from '../src/config/constants.js';

describe('admin video moderation schema', () => {
  test('accepts only the matching strict branch of the decision union', () => {
    expect(moderateAdminVideoRequestSchema.safeParse({ decision: 'approved' }).success).toBe(true);
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'rejected',
        reason: '  Video policy violation.  ',
      }),
    ).toMatchObject({
      success: true,
      data: {
        decision: 'rejected',
        reason: 'Video policy violation.',
      },
    });
    expect(moderateAdminVideoRequestSchema.safeParse({ decision: 'rejected' }).success).toBe(false);
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'approved',
        reason: 'This field does not belong to the approved branch.',
      }).success,
    ).toBe(false);
  });

  test('rejects blank and NUL-containing rejection reasons', () => {
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'rejected',
        reason: '   ',
      }).success,
    ).toBe(false);
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'rejected',
        reason: 'raison\u0000suite',
      }).success,
    ).toBe(false);
  });

  test('accepts exactly 1000 characters and rejects 1001 characters', () => {
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'rejected',
        reason: 'x'.repeat(VIDEO_REJECTION_REASON_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      moderateAdminVideoRequestSchema.safeParse({
        decision: 'rejected',
        reason: 'x'.repeat(VIDEO_REJECTION_REASON_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
