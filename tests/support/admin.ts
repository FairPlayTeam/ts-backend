import type { AdminPorts } from '../../src/services/admin.types.js';

export const createStubAdminService = (): AdminPorts => ({
  listAccounts: async () => ({
    accounts: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'admin-listed@example.com',
        username: 'admin_listed',
        displayName: 'Admin Listed',
        avatarUrl:
          'http://localhost:9000/fairplay-user-media/users/user-id/avatar/current-avatar.webp',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        isVerified: true,
        isBanned: false,
        bannedAt: null,
        lastLogin: new Date('2026-01-02T00:00:00.000Z'),
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        role: 'user',
      },
    ],
    total: 1,
    nextCursor: null,
  }),
});
