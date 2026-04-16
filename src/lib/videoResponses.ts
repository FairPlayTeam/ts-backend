import { getProxiedAssetUrl, getProxiedThumbnailUrl } from './utils.js';
import { getPublicVideoId } from './videoIds.js';

type RatingSource = {
  score: number;
  userId?: string;
};

type VideoUserSource = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl?: string | null;
};

type ViewCountSource = bigint | number | string;

type BaseVideoResponseSource = {
  id: string;
  publicId?: string | null;
  userId: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  viewCount: ViewCountSource;
  createdAt: Date | string;
  ratings: RatingSource[];
  user?: VideoUserSource;
};

type DetailedVideoResponseSource = BaseVideoResponseSource & {
  tags: string[];
  allowComments: boolean;
  license: string | null;
  updatedAt: Date | string;
  publishedAt: Date | string | null;
  duration: number | null;
  visibility: string;
  processingStatus: string;
  moderationStatus: string;
  user: VideoUserSource;
};

type MyVideoResponseSource = {
  id: string;
  publicId?: string | null;
  userId: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  viewCount: ViewCountSource;
  createdAt: Date | string;
  visibility: string;
  processingStatus: string;
  moderationStatus: string;
  ratings: RatingSource[];
};

export type VideoHlsResponse =
  | {
      master: string | null;
      variants: Record<string, string | null>;
      available: string[];
      preferred: string | null;
    }
  | null;

const toViewCountString = (value: ViewCountSource): string =>
  typeof value === 'bigint' ? value.toString() : String(value);

const mapVideoUser = (user: VideoUserSource | undefined) =>
  user
    ? {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl ?? null),
      }
    : undefined;

export const computeAvgRating = (ratings: RatingSource[]): number => {
  if (ratings.length === 0) {
    return 0;
  }

  const sum = ratings.reduce((acc, rating) => acc + rating.score, 0);
  return Math.round((sum / ratings.length) * 10) / 10;
};

export const mapPublicVideoSummary = (
  video: BaseVideoResponseSource,
) => ({
  id: getPublicVideoId(video),
  userId: video.userId,
  title: video.title,
  description: video.description,
  thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
  viewCount: toViewCountString(video.viewCount),
  avgRating: computeAvgRating(video.ratings),
  ratingsCount: video.ratings.length,
  createdAt: video.createdAt,
  user: mapVideoUser(video.user),
});

export const mapVideoDetails = (
  video: DetailedVideoResponseSource,
  options: {
    hls: VideoHlsResponse;
    userRating: number | null;
  },
) => ({
  id: getPublicVideoId(video),
  userId: video.userId,
  title: video.title,
  description: video.description,
  tags: video.tags,
  allowComments: video.allowComments,
  license: video.license,
  thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
  viewCount: toViewCountString(video.viewCount),
  avgRating: computeAvgRating(video.ratings),
  ratingsCount: video.ratings.length,
  userRating: options.userRating,
  duration: video.duration,
  visibility: video.visibility,
  processingStatus: video.processingStatus,
  moderationStatus: video.moderationStatus,
  createdAt: video.createdAt,
  updatedAt: video.updatedAt,
  publishedAt: video.publishedAt,
  hls: options.hls,
  user: mapVideoUser(video.user),
});

export const mapMyVideoItem = (video: MyVideoResponseSource) => ({
  id: getPublicVideoId(video),
  title: video.title,
  description: video.description,
  createdAt: video.createdAt,
  thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
  viewCount: toViewCountString(video.viewCount),
  avgRating: computeAvgRating(video.ratings),
  ratingsCount: video.ratings.length,
  visibility: video.visibility,
  processingStatus: video.processingStatus,
  moderationStatus: video.moderationStatus,
});
