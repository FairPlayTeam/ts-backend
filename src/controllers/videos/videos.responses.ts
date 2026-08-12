import { toIsoString, toNullableIsoString } from '../http.responses.js';
import type {
  CreateVideoResult,
  CreateVideoCommentResult,
  GetPublicVideoDetailResult,
  ListVideoCommentRepliesResult,
  ListVideoCommentsResult,
  ListPublicVideosResult,
  ListMyVideosResult,
  SearchPublicVideosResult,
  SignVideoMultipartUploadPartsResult,
  UploadVideoSourceThumbnailResult,
  VideoUploadSessionResult,
  VideoComment,
} from '../../services/videos.types.js';

const toVideoResponse = (video: CreateVideoResult['video']) => ({
  ...video,
  createdAt: toIsoString(video.createdAt),
  updatedAt: toIsoString(video.updatedAt),
});

export const toCreateVideoResponse = ({ video }: CreateVideoResult) => ({
  video: toVideoResponse(video),
});

const toVideoCommentResponseBody = (comment: VideoComment) =>
  comment.isDeleted
    ? {
        id: comment.id,
        content: null,
        isDeleted: true as const,
        createdAt: toIsoString(comment.createdAt),
        rootCommentId: null,
        likeCount: comment.likeCount,
        viewerHasLiked: comment.viewerHasLiked,
        replyingTo: null,
        author: null,
      }
    : {
        id: comment.id,
        content: comment.content,
        isDeleted: comment.isDeleted,
        createdAt: toIsoString(comment.createdAt),
        rootCommentId: comment.rootCommentId,
        likeCount: comment.likeCount,
        viewerHasLiked: comment.viewerHasLiked,
        replyingTo: comment.replyingTo
          ? {
              commentId: comment.replyingTo.commentId,
              username: comment.replyingTo.username,
            }
          : null,
        author: {
          username: comment.author.username,
          displayName: comment.author.displayName,
          avatarUrl: comment.author.avatarUrl,
        },
      };

export const toVideoCommentResponse = ({ comment }: CreateVideoCommentResult) => ({
  comment: toVideoCommentResponseBody(comment),
});

const toVideoCommentCursorResponse = (cursor: ListVideoCommentsResult['nextCursor']) =>
  cursor
    ? {
        id: cursor.id,
        createdAt: toIsoString(cursor.createdAt),
      }
    : null;

export const toVideoCommentsResponse = ({
  comments,
  nextCursor,
  total,
}: ListVideoCommentsResult) => ({
  comments: comments.map((comment) => ({
    ...toVideoCommentResponseBody(comment),
    replyCount: comment.replyCount,
  })),
  total,
  nextCursor: toVideoCommentCursorResponse(nextCursor),
});

export const toVideoCommentRepliesResponse = ({
  nextCursor,
  replies,
  total,
}: ListVideoCommentRepliesResult) => ({
  replies: replies.map(toVideoCommentResponseBody),
  total,
  nextCursor: toVideoCommentCursorResponse(nextCursor),
});

export const toMyVideosResponse = ({ nextCursor, total, videos }: ListMyVideosResult) => ({
  videos: videos.map((video) => toVideoResponse(video)),
  total,
  nextCursor: nextCursor
    ? {
        id: nextCursor.id,
        createdAt: toIsoString(nextCursor.createdAt),
      }
    : null,
});

export const toPublicVideoSearchResponse = ({
  nextCursor,
  total,
  videos,
}: SearchPublicVideosResult) => ({
  videos: videos.map((video) => ({
    ...video,
    publishedAt: toNullableIsoString(video.publishedAt),
    createdAt: toIsoString(video.createdAt),
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
    creator: {
      username: video.creator.username,
      displayName: video.creator.displayName,
      avatarUrl: video.creator.avatarUrl,
    },
    ratingAverage: video.ratingAverage,
    ratingCount: video.ratingCount,
    userRating: video.userRating,
    viewCount: video.viewCount,
    commentCount: video.commentCount,
    duration: video.duration,
    hlsMasterPath: video.hlsMasterPath,
  },
});

export const toVideoUploadSessionResponse = ({ uploadSession }: VideoUploadSessionResult) => ({
  uploadSession: {
    id: uploadSession.id,
    videoId: uploadSession.videoId,
    status: uploadSession.status,
    bucket: uploadSession.bucket,
    objectKey: uploadSession.objectKey,
    uploadId: uploadSession.uploadId,
    partSizeBytes: uploadSession.partSizeBytes,
    expectedSizeBytes: uploadSession.expectedSizeBytes,
    partCount: uploadSession.partCount,
    expiresAt: toIsoString(uploadSession.expiresAt),
    completedAt: toNullableIsoString(uploadSession.completedAt),
    abortedAt: toNullableIsoString(uploadSession.abortedAt),
    expiredAt: toNullableIsoString(uploadSession.expiredAt),
    createdAt: toIsoString(uploadSession.createdAt),
    updatedAt: toIsoString(uploadSession.updatedAt),
    parts: uploadSession.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      sizeBytes: part.sizeBytes,
      createdAt: toIsoString(part.createdAt),
    })),
  },
});

export const toSignedVideoUploadPartsResponse = (result: SignVideoMultipartUploadPartsResult) => ({
  uploadSessionId: result.uploadSessionId,
  parts: result.parts,
});

export const toUploadVideoSourceThumbnailResponse = ({
  thumbnail,
}: UploadVideoSourceThumbnailResult) => ({
  thumbnail: {
    ...thumbnail,
    createdAt: toIsoString(thumbnail.createdAt),
    updatedAt: toIsoString(thumbnail.updatedAt),
  },
});
