import { describe, expect, test } from 'bun:test';
import type { Prisma } from '@prisma/client';
import { recordVideoView, toUtcVideoViewDay } from '../src/services/videos/videoViews.js';

describe('video views', () => {
  test('uses a stable UTC calendar day across timezone offsets', () => {
    expect(toUtcVideoViewDay(new Date('2026-08-04T23:59:59.999Z'))).toBe('2026-08-04');
    expect(toUtcVideoViewDay(new Date('2026-08-05T00:00:00.000Z'))).toBe('2026-08-05');
    expect(toUtcVideoViewDay(new Date('2026-08-05T01:30:00.000+02:00'))).toBe('2026-08-04');
  });

  test('atomically guards owner views in SQL and reports whether the counter changed', async () => {
    let capturedQuery: Prisma.Sql | undefined;
    const prisma = {
      $executeRaw: async (query: Prisma.Sql) => {
        capturedQuery = query;
        return 1;
      },
    };

    await expect(
      recordVideoView(prisma, {
        userId: '11111111-1111-4111-8111-111111111111',
        videoId: '22222222-2222-4222-8222-222222222222',
        viewedOn: '2026-08-04',
      }),
    ).resolves.toBe(true);

    const sql = capturedQuery?.strings.join('?') ?? '';
    expect(sql).toContain('AND v."owner_id" <> CAST(? AS UUID)');
    expect(sql).toContain('ON CONFLICT ("user_id", "video_id", "viewed_on") DO NOTHING');
    expect(sql).toContain('SET "view_count" = v."view_count" + 1');

    await expect(
      recordVideoView(
        { $executeRaw: async () => 0 },
        {
          userId: '11111111-1111-4111-8111-111111111111',
          videoId: '22222222-2222-4222-8222-222222222222',
          viewedOn: '2026-08-04',
        },
      ),
    ).resolves.toBe(false);
  });
});
