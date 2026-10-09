import type { Prisma } from '@prisma/client';

export const PUBLIC_PROFILE_VISIBILITY_SCOPE = {
  isVerified: true,
  isBanned: false,
} satisfies Prisma.UserWhereInput;
