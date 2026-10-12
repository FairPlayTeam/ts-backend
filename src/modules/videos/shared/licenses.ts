import { VideoLicense as PrismaVideoLicense } from '@prisma/client';

export const VIDEO_LICENSES = Object.values(PrismaVideoLicense) as [
  PrismaVideoLicense,
  ...PrismaVideoLicense[],
];

export type VideoLicense = PrismaVideoLicense;
