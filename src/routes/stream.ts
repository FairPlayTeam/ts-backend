import { Router, Request, Response } from 'express';
import { minioClient, BUCKETS } from '../lib/minio.js';
import { hlsMasterIndex, hlsVariantIndex } from '../lib/paths.js';
import { registerRoute } from '../lib/docs.js';
import { authenticateSession, SessionAuthRequest } from '../lib/sessionAuth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

function contentTypeFor(path: string): string {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/MP2T';
  return 'application/octet-stream';
}

async function proxyObject(bucket: string, objectName: string, videoId: string, requesterId: string | null, res: Response) {
  try {
    const video = await prisma.video.findUnique({ where: { id: videoId } });
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const isPublic = video.visibility === 'public' && video.moderationStatus === 'approved' && video.processingStatus === 'done';

    if (!isPublic && video.userId !== requesterId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stream = await minioClient.getObject(bucket, objectName);
    res.setHeader('Content-Type', contentTypeFor(objectName));
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500);
      res.end(String(err));
    });
    stream.pipe(res);
  } catch (err: any) {
    const status = err?.code === 'NoSuchKey' ? 404 : 500;
    res.status(status).json({ error: 'Failed to fetch object' });
  }
}

router.get(
  '/videos/:userId/:videoId/master.m3u8',
  authenticateSession,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId } = req.params;
    const objectName = hlsMasterIndex(userId, videoId);
    await proxyObject(BUCKETS.VIDEOS, objectName, videoId, req.user?.id ?? null, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/master.m3u8',
  summary: 'Proxy HLS master playlist',
  description: 'Backend proxy for HLS master playlist. Consumed by players; usually not called directly by users. Note: userId must be the actual user ID (UUID), not username.',
  params: { userId: 'User ID (UUID)', videoId: 'Video ID' }
});

router.get(
  '/videos/:userId/:videoId/:quality/index.m3u8',
  authenticateSession,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId, quality } = req.params;
    const objectName = hlsVariantIndex(userId, videoId, quality);
    await proxyObject(BUCKETS.VIDEOS, objectName, videoId, req.user?.id ?? null, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/index.m3u8',
  summary: 'Proxy HLS variant playlist',
  description: 'Backend proxy for HLS variant playlist. Note: userId must be the actual user ID (UUID), not username.',
  params: { userId: 'User ID (UUID)', videoId: 'Video ID', quality: 'Video quality (240p, 480p, 720p, 1080p)' },
});

router.get(
  '/videos/:userId/:videoId/:quality/:segment',
  authenticateSession,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId, quality, segment } = req.params;
    const objectName = `${userId}/${videoId}/${quality}/${segment}`;
    await proxyObject(BUCKETS.VIDEOS, objectName, videoId, req.user?.id ?? null, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/:segment',
  summary: 'Proxy HLS segment (.ts)',
  description: 'Backend proxy for HLS video segments. Note: userId must be the actual user ID (UUID), not username.',
  params: { userId: 'User ID (UUID)', videoId: 'Video ID', quality: 'Video quality', segment: 'Segment filename' },
});

export default router;
