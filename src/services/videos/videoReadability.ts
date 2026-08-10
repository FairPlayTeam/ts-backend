import { Prisma } from '@prisma/client';
import type {
  VideoModerationStatus,
  VideoProcessingStatus,
  VideoVisibility,
} from './types/ports.types.js';

type VideoEngagementState = {
  moderationStatus: VideoModerationStatus;
  processingStatus: VideoProcessingStatus;
  visibility: VideoVisibility;
};

export const isVideoWritableEngagement = ({
  moderationStatus,
  processingStatus,
  visibility,
}: VideoEngagementState): boolean =>
  processingStatus === 'ready' &&
  (visibility === 'public' || visibility === 'unlisted') &&
  moderationStatus !== 'rejected';

export const readableVideoWhere = {
  processingStatus: 'ready',
  visibility: {
    in: ['public', 'unlisted'],
  },
} satisfies Prisma.VideoWhereInput;

export const READABLE_VIDEO_SCOPE_SQL = Prisma.sql`
  v."processing_status" = 'ready'
  AND v."visibility" IN ('public', 'unlisted')
`;

export const writableVideoEngagementWhere = {
  ...readableVideoWhere,
  moderationStatus: {
    not: 'rejected',
  },
} satisfies Prisma.VideoWhereInput;

export const WRITABLE_VIDEO_ENGAGEMENT_SCOPE_SQL = Prisma.sql`
  ${READABLE_VIDEO_SCOPE_SQL}
  AND v."moderation_status" <> 'rejected'
`;
