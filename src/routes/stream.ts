import { Router, Request, Response } from 'express';
import { minioClient, BUCKETS } from '../lib/minio.js';
import { hlsMasterIndex, hlsVariantIndex } from '../lib/paths.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

function contentTypeFor(path: string): string {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/MP2T';
  return 'application/octet-stream';
}

async function proxyObject(bucket: string, objectName: string, res: Response) {
  try {
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
  async (req: Request, res: Response) => {
    const { userId, videoId } = req.params;
    const objectName = hlsMasterIndex(userId, videoId);
    await proxyObject(BUCKETS.VIDEOS, objectName, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/master.m3u8',
  summary: 'Proxy HLS master playlist',
  description: 'Backend proxy for HLS master playlist. Consumed by players; usually not called directly by users.'
});

router.get(
  '/videos/:userId/:videoId/:quality/index.m3u8',
  async (req: Request, res: Response) => {
    const { userId, videoId, quality } = req.params;
    const objectName = hlsVariantIndex(userId, videoId, quality);
    await proxyObject(BUCKETS.VIDEOS, objectName, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/index.m3u8',
  summary: 'Proxy HLS variant playlist',
});

router.get(
  '/videos/:userId/:videoId/:quality/:segment',
  async (req: Request, res: Response) => {
    const { userId, videoId, quality, segment } = req.params;
    const objectName = `${userId}/${videoId}/${quality}/${segment}`;
    await proxyObject(BUCKETS.VIDEOS, objectName, res);
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/:segment',
  summary: 'Proxy HLS segment (.ts)',
});

export default router;
