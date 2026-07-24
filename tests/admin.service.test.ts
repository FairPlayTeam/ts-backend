import { describe, expect, test } from 'bun:test';
import type { AdminDependencies } from '../src/services/admin/admin.dependencies.js';
import type { AuthRole } from '../src/services/auth.roles.js';
import { createAdminService } from '../src/services/admin.service.js';
import {
  AdminAccountAlreadyBannedError,
  AdminAccountNotBannedError,
  AdminAccountNotFoundError,
  AdminBanReasonInvalidError,
  AdminRoleAlreadyAssignedError,
  AdminRoleAssignmentError,
  AdminRoleHierarchyError,
  AdminSelfBanError,
  AdminSelfUnbanError,
} from '../src/services/admin.errors.js';
import {
  BAN_ACCOUNT_SUCCESS_MESSAGE,
  UNBAN_ACCOUNT_SUCCESS_MESSAGE,
  UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
} from '../src/services/admin/admin.messages.js';
import { MailerDeliveryError } from '../src/services/mailer/mailer.errors.js';

const firstCreatedAt = new Date('2026-01-03T00:00:00.000Z');
const secondCreatedAt = new Date('2026-01-02T00:00:00.000Z');
const thirdCreatedAt = new Date('2026-01-01T00:00:00.000Z');
const updatedAt = new Date('2026-01-04T00:00:00.000Z');
const banTime = new Date('2026-01-05T00:00:00.000Z');
const actorUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const createAccountRecord = ({
  createdAt,
  id,
  mediaAssets = [],
}: {
  createdAt: Date;
  id: string;
  mediaAssets?: { objectKey: string }[];
}) => ({
  id,
  email: `${id}@example.com`,
  username: `user_${id.slice(0, 4)}`,
  displayName: `User ${id.slice(0, 4)}`,
  role: 'user' as const,
  isVerified: true,
  isBanned: false,
  bannedAt: null,
  createdAt,
  updatedAt,
  lastLogin: null,
  mediaAssets,
});

const createBanTargetRecord = ({
  id = targetUserId,
  isBanned = false,
  role = 'user' as const,
}: {
  id?: string;
  isBanned?: boolean;
  role?: AuthRole;
} = {}) => ({
  id,
  email: 'target@example.com',
  username: 'target_user',
  displayName: 'Target User',
  role,
  updatedAt,
  isBanned,
  bannedAt: isBanned ? new Date('2026-01-01T00:00:00.000Z') : null,
  banReason: isBanned ? 'Already banned' : null,
});

const applySelect = <RecordValue extends Record<string, unknown>>(
  record: RecordValue,
  select: Record<string, unknown> | undefined,
): Partial<RecordValue> => {
  if (!select) {
    return record;
  }

  return Object.fromEntries(
    Object.entries(select)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => [key, record[key]]),
  ) as Partial<RecordValue>;
};

const createDeps = ({
  queriedAccounts = [
    createAccountRecord({
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: firstCreatedAt,
      mediaAssets: [{ objectKey: 'users/first/avatar/current.webp' }],
    }),
    createAccountRecord({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: secondCreatedAt,
    }),
    createAccountRecord({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: thirdCreatedAt,
      mediaAssets: [{ objectKey: 'users/extra/avatar/current.webp' }],
    }),
  ],
  total = 3,
  banTarget = createBanTargetRecord(),
  mailerError,
  revokedSessionsCount = 2,
  now = banTime,
}: {
  queriedAccounts?: ReturnType<typeof createAccountRecord>[];
  total?: number;
  banTarget?: ReturnType<typeof createBanTargetRecord> | null;
  mailerError?: unknown;
  revokedSessionsCount?: number;
  now?: Date;
} = {}) => {
  let currentBanState = banTarget
    ? {
        isBanned: banTarget.isBanned,
        bannedAt: banTarget.bannedAt,
        banReason: banTarget.banReason,
      }
    : null;
  let persistedRole: AuthRole | null = null;
  const calls: {
    accountBanEmails: { email: string; reason: string }[];
    logs: { data: object; message: string }[];
    sessionUpdateMany?: unknown;
    signedUrlObjectKeys: string[];
    transactionOperationCount?: number;
    userFindUnique: unknown[];
    userCount?: unknown;
    userFindMany?: unknown;
    userUpdateMany?: unknown;
  } = {
    accountBanEmails: [],
    logs: [],
    signedUrlObjectKeys: [],
    userFindUnique: [],
  };
  const deps = {
    prisma: {
      $transaction: async (input: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
        if (Array.isArray(input)) {
          calls.transactionOperationCount = input.length;

          return Promise.all(input);
        }

        return input(deps.prisma);
      },
      session: {
        updateMany: async (args: unknown) => {
          calls.sessionUpdateMany = args;

          return { count: revokedSessionsCount };
        },
      },
      user: {
        findUnique: async (args: unknown) => {
          calls.userFindUnique.push(args);
          const { select } = args as { select?: Record<string, unknown> };

          if (!banTarget) {
            return null;
          }

          return applySelect(
            {
              ...banTarget,
              ...currentBanState,
              ...(persistedRole ? { role: persistedRole, updatedAt: now } : {}),
            },
            select,
          );
        },
        findMany: async (args: unknown) => {
          calls.userFindMany = args;

          return queriedAccounts;
        },
        count: async (args?: unknown) => {
          calls.userCount = args;

          return total;
        },
        updateMany: async (args: unknown) => {
          calls.userUpdateMany = args;

          const update = args as {
            data?: {
              bannedAt?: Date | null;
              banReason?: string | null;
              isBanned?: boolean;
              role?: AuthRole;
            };
            where?: { isBanned?: boolean; role?: { in?: AuthRole[] } };
          };

          if (!banTarget || !currentBanState) {
            return { count: 0 };
          }

          const currentRole = persistedRole ?? banTarget.role;
          const allowedRoles = update.where?.role?.in;

          if (allowedRoles && !allowedRoles.includes(currentRole)) {
            return { count: 0 };
          }

          if (update.data?.role !== undefined) {
            persistedRole = update.data.role;

            return { count: 1 };
          }

          if (
            update.where?.isBanned !== undefined &&
            currentBanState.isBanned !== update.where.isBanned
          ) {
            return { count: 0 };
          }

          if (update.data?.isBanned === true) {
            currentBanState = {
              isBanned: true,
              bannedAt: update.data.bannedAt ?? now,
              banReason: update.data.banReason ?? '',
            };

            return { count: 1 };
          }

          if (update.data?.isBanned === false) {
            currentBanState = {
              isBanned: false,
              bannedAt: null,
              banReason: null,
            };

            return { count: 1 };
          }

          return { count: 0 };
        },
      },
    },
    mailer: {
      sendAccountBannedEmail: async (email: string, reason: string) => {
        calls.accountBanEmails.push({ email, reason });

        if (mailerError) {
          throw mailerError;
        }
      },
    },
    objectStorage: {
      getSignedUrl: async (objectKey: string) => {
        calls.signedUrlObjectKeys.push(objectKey);

        return `signed:${objectKey}`;
      },
    },
    clock: {
      now: () => now,
    },
    logger: {
      warn: (data: object, message: string) => {
        calls.logs.push({ data, message });
      },
    },
  } as unknown as AdminDependencies;

  return { calls, deps };
};

describe('admin service accounts', () => {
  test('lists accounts with stable cursor pagination and signed avatar URLs', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await expect(service.listAccounts({ limit: 2 })).resolves.toEqual({
      accounts: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          email: '33333333-3333-4333-8333-333333333333@example.com',
          username: 'user_3333',
          displayName: 'User 3333',
          avatarUrl: 'signed:users/first/avatar/current.webp',
          role: 'user',
          isVerified: true,
          isBanned: false,
          bannedAt: null,
          createdAt: firstCreatedAt,
          updatedAt,
          lastLogin: null,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          email: '22222222-2222-4222-8222-222222222222@example.com',
          username: 'user_2222',
          displayName: 'User 2222',
          avatarUrl: null,
          role: 'user',
          isVerified: true,
          isBanned: false,
          bannedAt: null,
          createdAt: secondCreatedAt,
          updatedAt,
          lastLogin: null,
        },
      ],
      total: 3,
      nextCursor: {
        createdAt: secondCreatedAt,
        id: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(calls.userFindMany).toEqual({
      where: {},
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        role: true,
        isVerified: true,
        isBanned: true,
        bannedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        mediaAssets: {
          where: {
            kind: 'avatar',
          },
          select: {
            bucket: true,
            objectKey: true,
          },
          take: 1,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    });
    expect(calls.userCount).toBeUndefined();
    expect(calls.transactionOperationCount).toBe(2);
    expect(calls.signedUrlObjectKeys).toEqual(['users/first/avatar/current.webp']);
  });

  test('applies cursor filtering and caps oversized limits', async () => {
    const { calls, deps } = createDeps({ queriedAccounts: [] });
    const service = createAdminService(deps);
    const cursor = {
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
      id: '99999999-9999-4999-8999-999999999999',
    };

    await service.listAccounts({ cursor, limit: 10_000 });

    expect(calls.userFindMany).toEqual(
      expect.objectContaining({
        where: {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        },
        take: 101,
      }),
    );
  });

  test('filters accounts by search and ban status without counting the cursor window', async () => {
    const { calls, deps } = createDeps({ total: 7 });
    const service = createAdminService(deps);
    const cursor = {
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
      id: '99999999-9999-4999-8999-999999999999',
    };
    const searchFilter = {
      OR: [
        { username: { contains: 'Target', mode: 'insensitive' } },
        { displayName: { contains: 'Target', mode: 'insensitive' } },
        { email: { contains: 'Target', mode: 'insensitive' } },
      ],
    };
    const banStatusFilter = { isBanned: true };
    const cursorFilter = {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    };

    await service.listAccounts({
      banStatus: 'banned',
      cursor,
      limit: 2,
      search: '  Target  ',
    });

    expect(calls.userFindMany).toEqual(
      expect.objectContaining({
        where: {
          AND: [searchFilter, banStatusFilter, cursorFilter],
        },
        take: 3,
      }),
    );
    expect(calls.userCount).toEqual({
      where: {
        AND: [searchFilter, banStatusFilter],
      },
    });
  });

  test('filters accounts to non-banned users', async () => {
    const { calls, deps } = createDeps({ queriedAccounts: [] });
    const service = createAdminService(deps);

    await service.listAccounts({ banStatus: 'notbanned' });

    expect(calls.userFindMany).toEqual(
      expect.objectContaining({
        where: { isBanned: false },
      }),
    );
    expect(calls.userCount).toEqual({
      where: { isBanned: false },
    });
  });

  test('bans an account, revokes active sessions, and sends the ban reason by email', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await expect(
      service.banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: '  Repeated abusive behavior.  ',
      }),
    ).resolves.toEqual({
      message: BAN_ACCOUNT_SUCCESS_MESSAGE,
      account: {
        id: targetUserId,
        email: 'target@example.com',
        username: 'target_user',
        displayName: 'Target User',
        role: 'user',
        isBanned: true,
        bannedAt: banTime,
        banReason: 'Repeated abusive behavior.',
      },
      sessionsRevoked: 2,
      notificationEmailSent: true,
    });

    expect(calls.userUpdateMany).toEqual({
      where: {
        id: targetUserId,
        isBanned: false,
        role: { in: ['user', 'moderator'] },
      },
      data: {
        isBanned: true,
        bannedAt: banTime,
        banReason: 'Repeated abusive behavior.',
      },
    });
    expect(calls.sessionUpdateMany).toEqual({
      where: {
        userId: targetUserId,
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
    expect(calls.accountBanEmails).toEqual([
      {
        email: 'target@example.com',
        reason: 'Repeated abusive behavior.',
      },
    ]);
    expect(calls.logs).toEqual([]);
  });

  test('keeps the ban when the notification email cannot be delivered', async () => {
    const { calls, deps } = createDeps({
      mailerError: new MailerDeliveryError('SMTP unavailable'),
    });
    const service = createAdminService(deps);

    await expect(
      service.banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: 'Repeated abusive behavior.',
      }),
    ).resolves.toMatchObject({
      notificationEmailSent: false,
      account: {
        isBanned: true,
        banReason: 'Repeated abusive behavior.',
      },
    });

    expect(calls.userUpdateMany).toBeDefined();
    expect(calls.accountBanEmails).toEqual([
      {
        email: 'target@example.com',
        reason: 'Repeated abusive behavior.',
      },
    ]);
    expect(calls.logs).toEqual([
      expect.objectContaining({
        message: `Account ban notification email could not be sent for user ${targetUserId}`,
      }),
    ]);
  });

  test('rejects self-ban attempts before touching the target account', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await expect(
      service.banAccount({
        actorUserId: targetUserId,
        actorRole: 'admin',
        targetUserId,
        reason: 'Compromised account.',
      }),
    ).rejects.toBeInstanceOf(AdminSelfBanError);

    expect(calls.userFindUnique).toEqual([]);
    expect(calls.userUpdateMany).toBeUndefined();
    expect(calls.accountBanEmails).toEqual([]);
  });

  test('rejects unknown or already banned accounts', async () => {
    const unknownAccount = createDeps({ banTarget: null });
    await expect(
      createAdminService(unknownAccount.deps).banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: 'Policy violation.',
      }),
    ).rejects.toBeInstanceOf(AdminAccountNotFoundError);
    expect(unknownAccount.calls.userUpdateMany).toBeUndefined();

    const alreadyBannedAccount = createDeps({
      banTarget: createBanTargetRecord({ isBanned: true }),
    });
    await expect(
      createAdminService(alreadyBannedAccount.deps).banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: 'Policy violation.',
      }),
    ).rejects.toBeInstanceOf(AdminAccountAlreadyBannedError);
    expect(alreadyBannedAccount.calls.userUpdateMany).toBeUndefined();
  });

  test('rejects blank ban reasons at service boundary', async () => {
    const { calls, deps } = createDeps();

    await expect(
      createAdminService(deps).banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(AdminBanReasonInvalidError);

    expect(calls.userFindUnique).toEqual([]);
    expect(calls.accountBanEmails).toEqual([]);
  });

  test('rejects bans against equivalent or higher roles', async () => {
    const equivalentAdmin = createDeps({
      banTarget: createBanTargetRecord({ role: 'admin' }),
    });
    await expect(
      createAdminService(equivalentAdmin.deps).banAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        reason: 'Policy violation.',
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(equivalentAdmin.calls.userUpdateMany).toBeUndefined();
    expect(equivalentAdmin.calls.accountBanEmails).toEqual([]);

    const equivalentModerator = createDeps({
      banTarget: createBanTargetRecord({ role: 'moderator' }),
    });
    await expect(
      createAdminService(equivalentModerator.deps).banAccount({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
        reason: 'Policy violation.',
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(equivalentModerator.calls.userUpdateMany).toBeUndefined();

    const superiorAdmin = createDeps({
      banTarget: createBanTargetRecord({ role: 'admin' }),
    });
    await expect(
      createAdminService(superiorAdmin.deps).banAccount({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
        reason: 'Policy violation.',
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(superiorAdmin.calls.userUpdateMany).toBeUndefined();
  });

  test('unbans a banned account and clears ban metadata', async () => {
    const { calls, deps } = createDeps({
      banTarget: createBanTargetRecord({ isBanned: true }),
    });
    const service = createAdminService(deps);

    await expect(
      service.unbanAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
      }),
    ).resolves.toEqual({
      message: UNBAN_ACCOUNT_SUCCESS_MESSAGE,
      account: {
        id: targetUserId,
        email: 'target@example.com',
        username: 'target_user',
        displayName: 'Target User',
        role: 'user',
        isBanned: false,
        bannedAt: null,
        banReason: null,
      },
    });

    expect(calls.userUpdateMany).toEqual({
      where: {
        id: targetUserId,
        isBanned: true,
        role: { in: ['user', 'moderator'] },
      },
      data: {
        isBanned: false,
        bannedAt: null,
        banReason: null,
      },
    });
    expect(calls.sessionUpdateMany).toBeUndefined();
    expect(calls.accountBanEmails).toEqual([]);
  });

  test('rejects self-unban attempts before touching the target account', async () => {
    const { calls, deps } = createDeps({
      banTarget: createBanTargetRecord({ isBanned: true }),
    });

    await expect(
      createAdminService(deps).unbanAccount({
        actorUserId: targetUserId,
        actorRole: 'admin',
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(AdminSelfUnbanError);

    expect(calls.userFindUnique).toEqual([]);
    expect(calls.userUpdateMany).toBeUndefined();
  });

  test('rejects unban for missing or already unbanned accounts', async () => {
    const unknownAccount = createDeps({ banTarget: null });
    await expect(
      createAdminService(unknownAccount.deps).unbanAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(AdminAccountNotFoundError);
    expect(unknownAccount.calls.userUpdateMany).toBeUndefined();

    const alreadyUnbannedAccount = createDeps();
    await expect(
      createAdminService(alreadyUnbannedAccount.deps).unbanAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(AdminAccountNotBannedError);
    expect(alreadyUnbannedAccount.calls.userUpdateMany).toBeUndefined();
  });

  test('rejects unbans against equivalent or higher roles', async () => {
    const equivalentAdmin = createDeps({
      banTarget: createBanTargetRecord({ isBanned: true, role: 'admin' }),
    });

    await expect(
      createAdminService(equivalentAdmin.deps).unbanAccount({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(equivalentAdmin.calls.userUpdateMany).toBeUndefined();

    const superiorAdmin = createDeps({
      banTarget: createBanTargetRecord({ isBanned: true, role: 'admin' }),
    });

    await expect(
      createAdminService(superiorAdmin.deps).unbanAccount({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(superiorAdmin.calls.userUpdateMany).toBeUndefined();
  });

  test('updates an account role when the target current role is lower', async () => {
    const { calls, deps } = createDeps();
    const service = createAdminService(deps);

    await expect(
      service.updateAccountRole({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        role: 'admin',
      }),
    ).resolves.toEqual({
      message: UPDATE_ACCOUNT_ROLE_SUCCESS_MESSAGE,
      account: {
        id: targetUserId,
        email: 'target@example.com',
        username: 'target_user',
        displayName: 'Target User',
        role: 'admin',
        updatedAt: banTime,
      },
    });

    expect(calls.userUpdateMany).toEqual({
      where: {
        id: targetUserId,
        role: { in: ['user', 'moderator'] },
      },
      data: {
        role: 'admin',
      },
    });
  });

  test('allows a moderator to update a user to moderator but not admin', async () => {
    const promotion = createDeps();

    await expect(
      createAdminService(promotion.deps).updateAccountRole({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
        role: 'moderator',
      }),
    ).resolves.toMatchObject({
      account: {
        role: 'moderator',
      },
    });
    expect(promotion.calls.userUpdateMany).toEqual({
      where: {
        id: targetUserId,
        role: { in: ['user'] },
      },
      data: {
        role: 'moderator',
      },
    });

    const escalation = createDeps();

    await expect(
      createAdminService(escalation.deps).updateAccountRole({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(AdminRoleAssignmentError);
    expect(escalation.calls.userFindUnique).toEqual([]);
    expect(escalation.calls.userUpdateMany).toBeUndefined();
  });

  test('rejects role updates against equivalent or higher current roles', async () => {
    const equivalentAdmin = createDeps({
      banTarget: createBanTargetRecord({ role: 'admin' }),
    });

    await expect(
      createAdminService(equivalentAdmin.deps).updateAccountRole({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        role: 'user',
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(equivalentAdmin.calls.userUpdateMany).toBeUndefined();

    const superiorAdmin = createDeps({
      banTarget: createBanTargetRecord({ role: 'admin' }),
    });

    await expect(
      createAdminService(superiorAdmin.deps).updateAccountRole({
        actorUserId,
        actorRole: 'moderator',
        targetUserId,
        role: 'user',
      }),
    ).rejects.toBeInstanceOf(AdminRoleHierarchyError);
    expect(superiorAdmin.calls.userUpdateMany).toBeUndefined();
  });

  test('rejects role update no-ops and missing accounts', async () => {
    const sameRole = createDeps();

    await expect(
      createAdminService(sameRole.deps).updateAccountRole({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        role: 'user',
      }),
    ).rejects.toBeInstanceOf(AdminRoleAlreadyAssignedError);
    expect(sameRole.calls.userUpdateMany).toBeUndefined();

    const unknownAccount = createDeps({ banTarget: null });

    await expect(
      createAdminService(unknownAccount.deps).updateAccountRole({
        actorUserId,
        actorRole: 'admin',
        targetUserId,
        role: 'moderator',
      }),
    ).rejects.toBeInstanceOf(AdminAccountNotFoundError);
    expect(unknownAccount.calls.userUpdateMany).toBeUndefined();
  });
});
