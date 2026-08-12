import type { CommentDeletionOrigin, Prisma } from '@prisma/client';

export const softDeleteLockedVideoComments = async (
  tx: Prisma.TransactionClient,
  {
    commentIds,
    deletedAt,
    deletionOrigin,
  }: {
    commentIds: readonly string[];
    deletedAt: Date;
    deletionOrigin: CommentDeletionOrigin;
  },
): Promise<number> => {
  if (commentIds.length === 0) {
    return 0;
  }

  await tx.commentLike.deleteMany({
    where: {
      commentId: {
        in: [...commentIds],
      },
    },
  });

  const deleted = await tx.comment.updateMany({
    where: {
      id: {
        in: [...commentIds],
      },
      deletedAt: null,
    },
    data: {
      content: null,
      deletedAt,
      deletionOrigin,
      likeCount: 0,
    },
  });

  return deleted.count;
};
