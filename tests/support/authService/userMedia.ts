import type { AuthServiceTestCalls } from './context.js';

type UserMediaDeletionJobCalls = Pick<
  AuthServiceTestCalls,
  | 'userMediaDeletionJobCreateMany'
  | 'userMediaDeletionJobDeleteMany'
  | 'userMediaDeletionJobFindMany'
  | 'userMediaDeletionJobUpdateMany'
>;

export const createUserMediaDeletionJobMock = (calls: UserMediaDeletionJobCalls) => ({
  createMany: async (args: unknown) => {
    calls.userMediaDeletionJobCreateMany = args;

    const data = (args as { data?: unknown[] }).data;

    return { count: data?.length ?? 1 };
  },
  deleteMany: async (args: unknown) => {
    calls.userMediaDeletionJobDeleteMany = args;

    return { count: 1 };
  },
  findMany: async (args: unknown) => {
    calls.userMediaDeletionJobFindMany = args;

    return [];
  },
  updateMany: async (args: unknown) => {
    calls.userMediaDeletionJobUpdateMany = args;
  },
});

type UserMediaAssetDeletionCalls = UserMediaDeletionJobCalls &
  Pick<AuthServiceTestCalls, 'userMediaAssetDeleteMany' | 'userMediaAssetFindUnique'>;

export const createUserMediaAssetDeletionTransaction = ({
  calls,
  deleteMany,
  objectKey,
}: {
  calls: UserMediaAssetDeletionCalls;
  deleteMany?: (args: unknown) => Promise<{ count: number }>;
  objectKey: string;
}) => ({
  userMediaAsset: {
    findUnique: async (args: unknown) => {
      calls.userMediaAssetFindUnique = args;

      return { objectKey };
    },
    deleteMany: async (args: unknown) => {
      calls.userMediaAssetDeleteMany = args;

      return deleteMany ? deleteMany(args) : { count: 1 };
    },
  },
  userMediaDeletionJob: createUserMediaDeletionJobMock(calls),
});
