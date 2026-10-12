import { toIsoString, toNullableIsoString } from '../../../../controllers/http.responses.js';
import type {
  AdminVideoSummary,
  ListAdminVideosResult,
  ModerateAdminVideoResult,
  RequestAdminVideoDeletionResult,
} from '../../videoModeration/types.js';

const toAdminVideoResponse = (video: AdminVideoSummary) => ({
  id: video.id,
  publicId: video.publicId,
  ownerId: video.ownerId,
  username: video.username,
  title: video.title,
  moderationStatus: video.moderationStatus,
  processingStatus: video.processingStatus,
  visibility: video.visibility,
  createdAt: toIsoString(video.createdAt),
  thumbnailPath: video.thumbnailPath,
  publishedAt: toNullableIsoString(video.publishedAt),
  rejectedAt: toNullableIsoString(video.rejectedAt),
  rejectionReason: video.rejectionReason,
  deletionRequestedAt: toNullableIsoString(video.deletionRequestedAt),
  deletionReason: video.deletionReason,
  deletionOrigin: video.deletionOrigin,
});

export const toAdminVideosResponse = ({ nextCursor, total, videos }: ListAdminVideosResult) => ({
  videos: videos.map(toAdminVideoResponse),
  total,
  nextCursor: nextCursor
    ? {
        createdAt: toIsoString(nextCursor.createdAt),
        id: nextCursor.id,
      }
    : null,
});

export const toModerateAdminVideoResponse = ({ video }: ModerateAdminVideoResult) => ({
  video: toAdminVideoResponse(video),
});

export const toRequestAdminVideoDeletionResponse = ({
  video,
}: RequestAdminVideoDeletionResult) => ({
  video: toAdminVideoResponse(video),
});
