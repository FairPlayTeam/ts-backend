import type {
  VideoModerationStatus,
  VideoProcessingStatus,
  VideoVisibility,
} from '@prisma/client';

export type VideoAccessSubject = {
  userId: string;
  visibility: VideoVisibility;
  processingStatus: VideoProcessingStatus;
  moderationStatus: VideoModerationStatus;
  user: {
    isBanned: boolean;
  };
};

export type VideoAccessRequester =
  | {
      id?: string | null;
      role?: string | null;
    }
  | null
  | undefined;

export const isStaffRole = (role: string | null | undefined): boolean =>
  role === 'moderator' || role === 'admin';

export const isVideoApprovedAndReady = (
  video: Pick<VideoAccessSubject, 'processingStatus' | 'moderationStatus'>,
): boolean =>
  video.processingStatus === 'done' && video.moderationStatus === 'approved';

export const isVideoDirectlyAccessible = (
  video: VideoAccessSubject,
): boolean =>
  !video.user.isBanned &&
  isVideoApprovedAndReady(video) &&
  (video.visibility === 'public' || video.visibility === 'unlisted');

export const canAccessVideo = (
  video: VideoAccessSubject,
  requester: VideoAccessRequester,
): boolean => {
  if (requester?.id === video.userId) {
    return true;
  }

  if (isStaffRole(requester?.role)) {
    return true;
  }

  return isVideoDirectlyAccessible(video);
};

export const canBuildPlaybackUrls = (
  video: VideoAccessSubject,
  requester: VideoAccessRequester,
): boolean => canAccessVideo(video, requester) && video.processingStatus === 'done';
