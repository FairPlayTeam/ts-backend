import { toIsoString, toNullableIsoString } from '../../../controllers/http.responses.js';
import { toPublicProfileIdentityResponse } from '../../../controllers/shared/profile.responses.js';
import type {
  CreateVideoResult,
  GetPublicVideoDetailResult,
  ListPublicVideosResult,
  ListMyVideosResult,
  SearchPublicVideosResult,
  VideoRatingAggregateResult,
  VideoRatingResult,
} from '../types.js';

export const toVideoRatingAggregateResponse = (result: VideoRatingAggregateResult) => ({
  ratingAverage: result.ratingAverage,
  ratingCount: result.ratingCount,
});

export const toVideoRatingResponse = (result: VideoRatingResult) => ({
  ratingAverage: result.ratingAverage,
  ratingCount: result.ratingCount,
  userRating: result.userRating,
});

const toVideoResponse = (video: CreateVideoResult['video']) => ({
  publicId: video.publicId,
  title: video.title,
  description: video.description,
  tags: video.tags,
  license: video.license,
  visibility: video.visibility,
  allowComments: video.allowComments,
  processingStatus: video.processingStatus,
  moderationStatus: video.moderationStatus,
  thumbnailPath: video.thumbnailPath,
  ratingAverage: video.ratingAverage,
  ratingCount: video.ratingCount,
  createdAt: toIsoString(video.createdAt),
  updatedAt: toIsoString(video.updatedAt),
});

export const toCreateVideoResponse = ({ video }: CreateVideoResult) => ({
  video: toVideoResponse(video),
});

export const toMyVideosResponse = ({ nextCursor, total, videos }: ListMyVideosResult) => ({
  videos: videos.map((video) => ({
    ...toVideoResponse(video),
    deletionRequestedAt: toNullableIsoString(video.deletionRequestedAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        publicId: nextCursor.publicId,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toPublicVideoSearchResponse = ({
  creators,
  nextCursor,
  total,
  videos,
}: SearchPublicVideosResult) => ({
  videos: videos.map((video) => ({
    publicId: video.publicId,
    title: video.title,
    description: video.description,
    tags: video.tags,
    username: video.username,
    thumbnailPath: video.thumbnailPath,
    ratingAverage: video.ratingAverage,
    ratingCount: video.ratingCount,
    publishedAt: toNullableIsoString(video.publishedAt),
    createdAt: toIsoString(video.createdAt),
  })),
  creators: creators.map((creator) => ({
    ...toPublicProfileIdentityResponse(creator),
    followerCount: creator.followerCount,
    videoCount: creator.videoCount,
    createdAt: toIsoString(creator.createdAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        publicId: nextCursor.publicId,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toPublicVideosResponse = ({ nextCursor, total, videos }: ListPublicVideosResult) => ({
  videos: videos.map((video) => ({
    publicId: video.publicId,
    title: video.title,
    createdAt: toIsoString(video.createdAt),
    thumbnailPath: video.thumbnailPath,
    creator: {
      username: video.creator.username,
      displayName: video.creator.displayName,
    },
    viewCount: video.viewCount,
    duration: video.duration,
  })),
  total,
  nextCursor: nextCursor
    ? {
        publicId: nextCursor.publicId,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toPublicVideoDetailResponse = ({ video }: GetPublicVideoDetailResult) => ({
  video: {
    publicId: video.publicId,
    title: video.title,
    description: video.description,
    tags: video.tags,
    license: video.license,
    visibility: video.visibility,
    commentsOpen: video.commentsOpen,
    createdAt: toIsoString(video.createdAt),
    publishedAt: toNullableIsoString(video.publishedAt),
    thumbnailPath: video.thumbnailPath,
    creator: toPublicProfileIdentityResponse(video.creator),
    ratingAverage: video.ratingAverage,
    ratingCount: video.ratingCount,
    userRating: video.userRating,
    viewCount: video.viewCount,
    commentCount: video.commentCount,
    duration: video.duration,
    hlsMasterPath: video.hlsMasterPath,
  },
});
