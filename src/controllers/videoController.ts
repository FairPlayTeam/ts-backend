import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { BUCKETS } from '../lib/minio.js';
import { hlsVariantIndex } from '../lib/paths.js';
import { minioClient } from '../lib/minio.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedThumbnailUrl, getProxiedAssetUrl } from '../lib/utils.js';
import { validate as isUUID } from 'uuid';
import { startOfDay } from 'date-fns';

const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;

const clampPagination = (page: unknown, limit: unknown) => {
  const p = Math.max(1, parseInt(String(page)) || 1);
  const l = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(String(limit)) || DEFAULT_PAGE_LIMIT));
  return { page: p, limit: l, skip: (p - 1) * l };
};

const incrementVideoView = async (
  videoId: string,
  videoUserId: string,
  requesterId: string,
): Promise<void> => {
	if (!requesterId) return;

  const today = startOfDay(new Date());

  try {
		let justCreated = false;
		try {
			await prisma.videoView.create({
				data: { userId: requesterId, videoId, date: today },
			});
			justCreated = true;
		} catch (e: any) {
			if (e?.code === 'P2002') return;
			throw e;
		}

		if (!justCreated) return;

		await prisma.$transaction([
			prisma.video.update({
				where: { id: videoId },
				data: { viewCount: { increment: 1n } },
			}),
			prisma.user.update({
				where: { id: videoUserId },
				data: { totalViews: { increment: 1n } },
			}),
		]);
  } catch (error) {
		console.error('Error incrementing video view:', error);
  }
};

const computeAvgRating = (ratings: { score: number }[]): number => {
  if (ratings.length === 0) return 0;
  const sum = ratings.reduce((acc, r) => acc + r.score, 0);
  return Math.round((sum / ratings.length) * 10) / 10;
};

const PUBLIC_VIDEO_FILTER = {
  processingStatus: 'done',
  moderationStatus: 'approved',
  visibility: 'public',
  user: { isBanned: false },
} as const;

export const getVideos = async (req: Request, res: Response): Promise<void> => {
  try {
		const { page, limit, skip } = clampPagination(req.query.page, req.query.limit);

		const [videos, total] = await Promise.all([
			prisma.video.findMany({
				where: PUBLIC_VIDEO_FILTER,
				include: {
					user: { select: { username: true, displayName: true } },
					ratings: { select: { score: true } },
				},
				orderBy: { createdAt: 'desc' },
				skip,
				take: limit,
			}),
			prisma.video.count({ where: PUBLIC_VIDEO_FILTER }),
		]);

		const videosWithUrls = videos.map((video) => ({
			...video,
			thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
			viewCount: video.viewCount.toString(),
			avgRating: computeAvgRating(video.ratings),
			ratingsCount: video.ratings.length,
		}));

		res.json({
			videos: videosWithUrls,
			pagination: {
			page,
			limit,
			totalItems: total,
			totalPages: Math.ceil(total / limit),
			itemsReturned: videosWithUrls.length,
			},
		});
  } catch (error) {
		console.error('Error fetching videos:', error);
		res.status(500).json({ error: 'Failed to fetch videos' });
  }
};

export const getTopViewedVideos = async (_req: Request, res: Response): Promise<void> => {
  try {
		const videos = await prisma.video.findMany({
			where: PUBLIC_VIDEO_FILTER,
			include: {
			user: { select: { username: true, displayName: true } },
			ratings: { select: { score: true } },
			},
			orderBy: { viewCount: 'desc' },
			take: 3,
		});

		const videosWithUrls = videos.map((video) => ({
			...video,
			thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
			viewCount: video.viewCount.toString(),
			avgRating: computeAvgRating(video.ratings),
			ratingsCount: video.ratings.length,
		}));

		res.json({ videos: videosWithUrls });
  } catch (error) {
		console.error('Error fetching top viewed videos:', error);
		res.status(500).json({ error: 'Failed to fetch top viewed videos' });
  }
};

export const searchVideos = async (req: Request, res: Response): Promise<void> => {
  try {
		const { q = '' } = req.query;
		const { page, limit, skip } = clampPagination(req.query.page, req.query.limit);

		const searchTerm = String(q).trim();

		const where: any = { ...PUBLIC_VIDEO_FILTER };
		if (searchTerm.length > 0) {
			where.OR = [
				{ title: { contains: searchTerm, mode: 'insensitive' } },
				{ user: { username: { contains: searchTerm, mode: 'insensitive' } } },
				{ user: { displayName: { contains: searchTerm, mode: 'insensitive' } } },
			];
		}

		const [rows, total] = await Promise.all([
			prisma.video.findMany({
				where,
				include: {
					user: { select: { username: true, displayName: true } },
					ratings: { select: { score: true } },
				},
				orderBy: { createdAt: 'desc' },
				skip,
				take: limit,
			}),
			prisma.video.count({ where }),
		]);

		const results = rows.map((video) => ({
			id: video.id,
			title: video.title,
			thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
			viewCount: video.viewCount.toString(),
			avgRating: computeAvgRating(video.ratings),
			ratingsCount: video.ratings.length,
			user: video.user,
			createdAt: video.createdAt,
		}));

		res.json({
			videos: results,
			pagination: {
			page,
			limit,
			totalItems: total,
			totalPages: Math.ceil(total / limit),
			itemsReturned: results.length,
			},
			query: { q: searchTerm },
		});
  } catch (error) {
		console.error('Error searching videos:', error);
		res.status(500).json({ error: 'Failed to search videos' });
  }
};

export const getVideoById = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
		const { id } = req.params;

		if (!isUUID(id)) {
			res.status(404).json({ error: 'Video not found' });
			return;
		}

		const video = await prisma.video.findUnique({
			where: { id },
			include: {
				user: {
					select: {
						id: true,
						username: true,
						displayName: true,
						avatarUrl: true,
						isBanned: true,
					},
				},
				ratings: true,
			},
		});

		if (!video) {
			res.status(404).json({ error: 'Video not found' });
			return;
		}

		const requesterId: string | null = req.user?.id ?? null;
		const requesterRole: string | null = req.user?.role ?? null;

		const isPubliclyPlayable =
			video.processingStatus === 'done' &&
			video.moderationStatus === 'approved' &&
			video.visibility === 'public';

		if (isPubliclyPlayable && video.user.isBanned && requesterId !== video.userId) {
			res.status(403).json({ error: 'Video not available' });
			return;
		}

		const isOwner = requesterId === video.userId;
		const isModerator = requesterRole === 'moderator' || requesterRole === 'admin';
		
		if (!isPubliclyPlayable && !isOwner && !isModerator) {
			res.status(403).json({ error: 'Video not available' });
			return;
		}

		if (requesterId) {
			await incrementVideoView(video.id, video.userId, requesterId);
		}

		let hls: any = null;

		const canBuildHls =
			isPubliclyPlayable ||
			((isOwner || isModerator) && video.processingStatus === 'done');

		if (canBuildHls) {
			const protocol = req.get('X-Forwarded-Proto') || req.protocol;
			const base = `${protocol}://${req.get('host')}`;
			const candidateQualities = ['1080p', '720p', '480p', '240p'];

			const statResults = await Promise.allSettled(
			candidateQualities.map((q) =>
				minioClient.statObject(BUCKETS.VIDEOS, hlsVariantIndex(video.userId, video.id, q))
			)
			);

			const available = candidateQualities.filter((_, i) => statResults[i].status === 'fulfilled');

			const variantUrls: Record<string, string | null> = {};
			for (const q of candidateQualities) {
			variantUrls[q] = available.includes(q)
				? `${base}/stream/videos/${video.userId}/${video.id}/${q}/index.m3u8`
				: null;
			}

			hls = {
			master: `${base}/stream/videos/${video.userId}/${video.id}/master.m3u8`,
			variants: variantUrls,
			available,
			preferred: available[0] ?? null,
			};
		}

		const { isBanned: _banned, ...publicUser } = video.user;

		const userRating = requesterId
			? (video.ratings.find((r) => r.userId === requesterId)?.score ?? null)
			: null;

		res.json({
			...video,
			viewCount: video.viewCount.toString(),
			hls,
			thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
			avgRating: computeAvgRating(video.ratings),
			ratingsCount: video.ratings.length,
			userRating,
			user: {
				...publicUser,
				avatarUrl: getProxiedAssetUrl(video.user.id, video.user.avatarUrl),
			},
		});
  } catch (error) {
		console.error('Error fetching video:', error);
		res.status(500).json({ error: 'Failed to fetch video' });
  }
};

export const getUserVideos = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
		const userId = req.user!.id;
		const { page, limit, skip } = clampPagination(req.query.page, req.query.limit);

		const [videos, total] = await Promise.all([
			prisma.video.findMany({
			where: { userId },
			include: { ratings: { select: { score: true } } },
			orderBy: { createdAt: 'desc' },
			skip,
			take: limit,
			}),
			prisma.video.count({ where: { userId } }),
		]);

		const videosWithUrls = videos.map((video) => ({
			...video,
			thumbnailUrl: getProxiedThumbnailUrl(video.userId, video.id, video.thumbnail),
			viewCount: video.viewCount.toString(),
			avgRating: computeAvgRating(video.ratings),
			ratingsCount: video.ratings.length,
		}));

		res.json({
			videos: videosWithUrls,
			pagination: {
			page,
			limit,
			totalItems: total,
			totalPages: Math.ceil(total / limit),
			itemsReturned: videosWithUrls.length,
			},
		});
  } catch (error) {
		console.error('Error fetching user videos:', error);
		res.status(500).json({ error: 'Failed to fetch user videos' });
  }
};

export const updateVideo = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { id: videoId } = req.params;
  const { title, description, visibility } = req.body;

  try {
		const video = await prisma.video.findUnique({ where: { id: videoId } });

		if (!video) {
			res.status(404).json({ error: 'Video not found' });
			return;
		}

		if (video.userId !== userId) {
			res.status(403).json({ error: 'You are not authorized to edit this video' });
			return;
		}

		const updatedVideo = await prisma.video.update({
			where: { id: videoId },
			data: { title, description, visibility },
		});

		res.json({
			message: 'Video updated successfully',
			video: {
			...updatedVideo,
			thumbnailUrl: getProxiedThumbnailUrl(updatedVideo.userId, updatedVideo.id, updatedVideo.thumbnail),
			},
		});
  } catch (error) {
		console.error('Update video error:', error);
		res.status(500).json({ error: 'Failed to update video' });
  }
};

export const deleteVideo = async (req: SessionAuthRequest, res: Response): Promise<void> => {
  try {
		const { id } = req.params;
		const requester = req.user;

		if (!requester) {
			res.status(401).json({ error: 'Unauthorized' });
			return;
		}

		if (!isUUID(id)) {
			res.status(404).json({ error: 'Video not found' });
			return;
		}

		const video = await prisma.video.findUnique({
			where: { id },
			select: { id: true, userId: true, thumbnail: true },
		});

		if (!video) {
			res.status(404).json({ error: 'Video not found' });
			return;
		}

		const isOwner = requester.id === video.userId;
		const isModerator = requester.role === 'admin' || requester.role === 'moderator';

		if (!isOwner && !isModerator) {
			res.status(403).json({ error: 'You are not authorized to delete this video' });
			return;
		}

		await deleteMinioPrefix(BUCKETS.VIDEOS, `${video.userId}/${video.id}/`);

		if (video.thumbnail) {
			const filename = video.thumbnail.split('/').pop();
			if (filename) {
				try {
				await minioClient.removeObject(
					BUCKETS.VIDEOS,
					`thumbnails/${video.userId}/${video.id}/${filename}`,
				);
				} catch (_) {}
			}
		}

		await prisma.$transaction(async (tx) => {
			await tx.commentLike.deleteMany({
				where: { comment: { videoId: video.id } },
			});
			await tx.rating.deleteMany({ where: { videoId: video.id } });
			await tx.comment.deleteMany({ where: { videoId: video.id } });
			await tx.videoView.deleteMany({ where: { videoId: video.id } });
			await tx.video.delete({ where: { id: video.id } });

			const videoCount = await tx.video.count({ where: { userId: video.userId } });
			await tx.user.update({
				where: { id: video.userId },
				data: { videoCount },
			});
		});

		res.json({ message: 'Video deleted successfully' });
  } catch (error) {
		console.error('Error deleting video:', error);
		res.status(500).json({ error: 'Failed to delete video' });
  }
};

const deleteMinioPrefix = async (bucket: string, prefix: string): Promise<void> => {
  const objectNames: string[] = [];

  await new Promise<void>((resolve, reject) => {
		const stream = minioClient.listObjectsV2(bucket, prefix, true);
		stream.on('data', (obj) => { if (obj.name) objectNames.push(obj.name); });
		stream.on('end', resolve);
		stream.on('error', reject);
  });

  if (objectNames.length === 0) return;

	await minioClient.removeObjects(bucket, objectNames);
};