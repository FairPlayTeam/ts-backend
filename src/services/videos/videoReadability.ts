import type { Prisma } from '@prisma/client';

export const readableVideoWhere = {
  processingStatus: 'ready',
  visibility: {
    in: ['public', 'unlisted'],
  },
} satisfies Prisma.VideoWhereInput;
