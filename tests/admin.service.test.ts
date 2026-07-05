import { describe, expect, test } from 'bun:test';
import type { AdminDependencies } from '../src/services/admin/admin.dependencies.js';
import { createAdminService } from '../src/services/admin.service.js';
import {
  AdminAccountAlreadyBannedError,
  AdminAccountNotFoundError,
  AdminBanReasonInvalidError,
  AdminRoleHierarchyError,
  AdminSelfBanError,
} from '../src/services/admin.errors.js';
import { BAN_ACCOUNT_SUCCESS_MESSAGE } from '../src/services/admin/admin.messages.js';
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
  role?: 'admin' | 'moderator' | 'user';
} = {}) => ({
  id,
  email: 'target@example.com',
  username: 'target_user',
  displayName: 'Target User',
  role,
  isBanned,
  bannedAt: isBanned ? new Date('2026-01-01T00:00:00.000Z') : null,
  banReason: isBanned ? 'Already banned' : null,
});

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
  let persistedBan: { bannedAt: Date; banReason: string } | null = null;
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

          if (!banTarget) {
            return null;
          }

          if (!persistedBan) {
            return {
              id: banTarget.id,
              isBanned: banTarget.isBanned,
              role: banTarget.role,
            };
          }

          return {
            ...banTarget,
            isBanned: true,
            bannedAt: persistedBan.bannedAt,
            banReason: persistedBan.banReason,
          };
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

          if (!banTarget || banTarget.isBanned) {
            return { count: 0 };
          }

          const update = args as { data?: { bannedAt?: Date; banReason?: string } };
          persistedBan = {
            bannedAt: update.data?.bannedAt ?? now,
            banReason: update.data?.banReason ?? '',
          };

          return { count: 1 };
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
});
