import { fixedNow, type AuthServiceTestCalls } from './context.js';

type UserMediaAssetDeletionCalls = Pick<
  AuthServiceTestCalls,
  'externalResourceTargetUpdate' | 'userMediaAssetDeleteMany' | 'userMediaAssetFindUnique'
>;

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

      return {
        id: 'asset-id',
        objectKey,
        externalResourceTargetId: 'target-id',
      };
    },
    deleteMany: async (args: unknown) => {
      calls.userMediaAssetDeleteMany = args;

      return deleteMany ? deleteMany(args) : { count: 1 };
    },
  },
  externalResourceTarget: {
    findUnique: async () => ({
      state: 'confirmed_present',
      quiescenceNotBefore: null,
      nextAttemptAt: fixedNow,
    }),
    update: async (args: unknown) => {
      calls.externalResourceTargetUpdate = args;
      return { id: 'target-id' };
    },
  },
});
