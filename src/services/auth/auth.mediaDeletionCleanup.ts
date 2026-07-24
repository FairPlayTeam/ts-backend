import type {
  AuthMaintenancePort,
  ReconcileUserMediaTargetsInput,
  ReconcileUserMediaTargetsResult,
} from './types/maintenance.types.js';
import type { AuthDependencies } from './auth.dependencies.js';
import { RECONCILE_USER_MEDIA_TARGETS_SUCCESS_MESSAGE } from './auth.messages.js';
import { createUserMediaReconciliationHandler } from './auth.userMedia.js';

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
