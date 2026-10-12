import type {
  AuthMaintenancePort,
  ReconcileUserMediaTargetsInput,
  ReconcileUserMediaTargetsResult,
} from '../maintenance/types.js';
import type { AuthDependencies } from '../dependencies.js';
import { RECONCILE_USER_MEDIA_TARGETS_SUCCESS_MESSAGE } from '../messages.js';
import { createUserMediaReconciliationHandler } from './storage.js';

type MediaDeletionCleanupService = Pick<AuthMaintenancePort, 'reconcileUserMediaTargets'>;

export const createMediaDeletionCleanupService = (
  deps: AuthDependencies,
): MediaDeletionCleanupService => ({
  async reconcileUserMediaTargets({
    limit,
  }: ReconcileUserMediaTargetsInput): Promise<ReconcileUserMediaTargetsResult> {
    const result = await deps.externalResources.reconcileDue({
      roles: ['user_media'],
      ...(limit === undefined ? {} : { limit }),
      handlers: {
        user_media: createUserMediaReconciliationHandler(deps),
      },
    });

    return {
      message: RECONCILE_USER_MEDIA_TARGETS_SUCCESS_MESSAGE,
      mediaTargetsConfirmed: result.confirmed,
      mediaTargetsFailed: result.failed,
    };
  },
});
