import type { AuthService, ExportUserDataInput } from '../auth.types.js';
import type { AuthDependencies } from './auth.dependencies.js';

type DataExportService = Pick<AuthService, 'exportUserData'>;

export const createDataExportService = (deps: AuthDependencies): DataExportService => ({
  async exportUserData({ userId, currentSessionId }: ExportUserDataInput) {
    const exportedAt = deps.clock.now();

    const user = await deps.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        role: true,
        isVerified: true,
        isBanned: true,
        bannedAt: true,
        createdAt: true,
        updatedAt: true,
        lastLogin: true,
        mediaAssets: {
          select: {
            id: true,
            kind: true,
            objectKey: true,
            mimeType: true,
            sizeBytes: true,
            width: true,
            height: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        },
        sessions: {
          select: {
            id: true,
            sessionKeySuffix: true,
            ipAddress: true,
            userAgent: true,
            deviceInfo: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
            lastUsedAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        emailVerificationTokens: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
        passwordResetToken: {
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('Authenticated user could not be found for data export');
    }

    const { emailVerificationTokens, mediaAssets, passwordResetToken, sessions, ...exportedUser } =
      user;

    return {
      exportedAt,
      user: exportedUser,
      mediaAssets,
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: session.id === currentSessionId,
      })),
      emailVerificationToken: emailVerificationTokens[0] ?? null,
      passwordResetToken,
    };
  },
});
