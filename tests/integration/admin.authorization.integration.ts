import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { INSUFFICIENT_PERMISSIONS_MESSAGE } from '../../src/middleware/routeProtection.js';
import { createVerifiedSession } from './support/fixtures.js';
import { coordinateGatedOperations } from './support/asyncBarriers.js';
import {
  beginHeldActorDowngrade,
  waitForBlockedActorAuthorizationQuery,
} from './support/actorAuthorization.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationApp,
  createPostgresApplicationName,
  createPrismaClient,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

const expectForbiddenResponse = (response: request.Response): void => {
  expect(response.status).toBe(403);
  expect(response.body).toEqual({
    error: 'Forbidden',
    message: INSUFFICIENT_PERMISSIONS_MESSAGE,
  });
};

describe('admin actor authorization integration', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('returns forbidden when an account-list actor downgrade commits while its row lock waits', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const admin = await createVerifiedSession(runtime, {
      email: 'admin-list-race@example.com',
      username: 'admin_list_race',
    });
    await runtime.prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    const app = await createIntegrationApp(runtime);
    const downgrade = beginHeldActorDowngrade(runtime, admin.userId, 'moderator');

    const [response] = await coordinateGatedOperations({
      cleanup: [downgrade.disconnect],
      gateBarrierDescription: 'the uncommitted admin downgrade before account listing',
      gateOperation: downgrade.transaction,
      gatePaused: downgrade.paused,
      releaseGate: downgrade.release,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const listRequest = trackOperation(
          request(app)
            .get('/admin/users')
            .set('Authorization', `Bearer ${admin.sessionKey}`)
            .then((result) => result),
        );
        await waitForSignal({
          description: 'account listing to wait on the locked admin actor row',
          observe: (signal) => waitForBlockedActorAuthorizationQuery(activeRuntime, signal),
        });

        return [listRequest] as const;
      },
    });

    expectForbiddenResponse(response);
    await expect(
      runtime.prisma.user.findUniqueOrThrow({
        where: { id: admin.userId },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: 'moderator' });
  });

  test('holds the actor lock until the privileged role update commits', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const admin = await createVerifiedSession(runtime, {
      email: 'admin-action-first@example.com',
      username: 'admin_action_first',
    });
    const target = await createVerifiedSession(runtime, {
      email: 'admin-action-first-target@example.com',
      username: 'admin_first_target',
    });
    await runtime.prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    const app = await createIntegrationApp(runtime);
    const gatePrisma = createPrismaClient(runtime.databaseUrl);
    const downgradeApplicationName = createPostgresApplicationName();
    const downgradePrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: downgradeApplicationName,
    });
    const targetLocked = Promise.withResolvers<void>();
    const releaseTarget = Promise.withResolvers<void>();
    // Holding the target pauses the actual business UPDATE after actor authorization, without
    // instrumenting the service or confusing a pre-query callback with a PostgreSQL lock wait.
    const gateTransaction = gatePrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "users"
          WHERE "id" = CAST(${target.userId} AS UUID)
          FOR UPDATE
        `;
        targetLocked.resolve();
        await releaseTarget.promise;
      },
      { timeout: 15_000 },
    );

    const [response, targetAtDowngrade] = await coordinateGatedOperations({
      cleanup: [() => gatePrisma.$disconnect(), () => downgradePrisma.$disconnect()],
      gateBarrierDescription: 'the locked target before the privileged role update',
      gateOperation: gateTransaction,
      gatePaused: targetLocked.promise,
      releaseGate: releaseTarget.resolve,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const roleUpdateRequest = trackOperation(
          request(app)
            .patch(`/admin/users/${target.userId}/role`)
            .set('Authorization', `Bearer ${admin.sessionKey}`)
            .send({ role: 'moderator' })
            .then((result) => result),
        );
        await waitForSignal({
          description: 'the authorized role update to wait on its target row',
          observe: (signal) =>
            waitForPostgresLockWaiters(activeRuntime.prisma, {
              applicationNames: [activeRuntime.postgresApplicationName],
              expectedCount: 1,
              queryFragments: ['UPDATE', '"users"', '"role"'],
              signal,
            }),
        });

        const downgrade = trackOperation(
          downgradePrisma.$transaction(async (tx) => {
            await tx.user.update({
              where: { id: admin.userId },
              data: { role: 'moderator' },
            });

            // Observe committed business state from the revoking connection, not HTTP promise
            // settlement order: the target update must be visible when revocation can proceed.
            return tx.user.findUniqueOrThrow({
              where: { id: target.userId },
              select: { role: true },
            });
          }),
        );
        await waitForSignal({
          description: 'the admin downgrade to wait for the privileged transaction to commit',
          observe: (signal) =>
            waitForPostgresLockWaiters(activeRuntime.prisma, {
              applicationNames: [downgradeApplicationName],
              expectedCount: 1,
              queryFragments: ['UPDATE', '"users"', '"role"'],
              signal,
            }),
        });

        return [roleUpdateRequest, downgrade] as const;
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.account).toMatchObject({ id: target.userId, role: 'moderator' });
    expect(targetAtDowngrade).toEqual({ role: 'moderator' });
    await expect(
      runtime.prisma.user.findUniqueOrThrow({
        where: { id: admin.userId },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: 'moderator' });
  });

  test('leaves the target unchanged when an admin downgrade commits before a role update', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const activeRuntime = runtime;
    const admin = await createVerifiedSession(runtime, {
      email: 'admin-mutation-race@example.com',
      username: 'admin_mutation_race',
    });
    const target = await createVerifiedSession(runtime, {
      email: 'admin-mutation-target@example.com',
      username: 'admin_mut_target',
    });
    await runtime.prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    const app = await createIntegrationApp(runtime);
    const downgrade = beginHeldActorDowngrade(runtime, admin.userId, 'moderator');

    const [response] = await coordinateGatedOperations({
      cleanup: [downgrade.disconnect],
      gateBarrierDescription: 'the uncommitted admin downgrade before an account role update',
      gateOperation: downgrade.transaction,
      gatePaused: downgrade.paused,
      releaseGate: downgrade.release,
      runWhileGateHeld: async ({ trackOperation, waitForSignal }) => {
        const roleUpdateRequest = trackOperation(
          request(app)
            .patch(`/admin/users/${target.userId}/role`)
            .set('Authorization', `Bearer ${admin.sessionKey}`)
            .send({ role: 'moderator' })
            .then((result) => result),
        );
        await waitForSignal({
          description: 'the account role update to wait on the locked admin actor row',
          observe: (signal) => waitForBlockedActorAuthorizationQuery(activeRuntime, signal),
        });

        return [roleUpdateRequest] as const;
      },
    });

    expectForbiddenResponse(response);
    await expect(
      runtime.prisma.user.findUniqueOrThrow({
        where: { id: target.userId },
        select: { role: true },
      }),
    ).resolves.toEqual({ role: 'user' });
  });
});
