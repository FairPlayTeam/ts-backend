import { Prisma } from '@prisma/client';

export const readableVideoWhere = {
  processingStatus: 'ready',
  visibility: {
    in: ['public', 'unlisted'],
  },
} satisfies Prisma.VideoWhereInput;

export const READABLE_VIDEO_SCOPE_SQL = Prisma.sql`
  v."processing_status" = 'ready'
  AND v."visibility" IN ('public', 'unlisted')
`;
