import { prisma } from './lib/prisma.js';
import { createCommentsService } from './modules/comments/index.js';

const clock = {
  now: () => new Date(),
};

export const commentsService = createCommentsService({ prisma, clock });
