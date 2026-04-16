import { Router, Response } from 'express';
import { minioClient, BUCKETS } from '../lib/minio.js';
import { hlsMasterIndex, hlsVariantIndex } from '../lib/paths.js';
import { registerRoute } from '../lib/docs.js';
import { rewritePlaylistWithToken } from '../lib/hlsPlaylist.js';
import {
  createPlaybackToken,
  verifyPlaybackToken,
} from '../lib/playbackTokens.js';
import {
  SessionAuthRequest,
  optionalSessionAuthenticate,
} from '../lib/sessionAuth.js';
import { prisma } from '../lib/prisma.js';
import { canBuildPlaybackUrls } from '../lib/videoAccess.js';

const router = Router();

function contentTypeFor(path: string): string {
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.ts')) return 'video/MP2T';
  return 'application/octet-stream';
}

const getRequestedPlaybackToken = (
  req: SessionAuthRequest,
): string | null => {
  const token = req.query.token;

  if (typeof token !== 'string') {
    return null;
  }

  const trimmedToken = token.trim();
  return trimmedToken.length > 0 ? trimmedToken : null;
};

const readObjectText = async (
  bucket: string,
  objectName: string,
): Promise<string> => {
  const stream = await minioClient.getObject(bucket, objectName);
  const chunks: Buffer[] = [];

  return new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', reject);
  });
};

type StreamAuthorization =
  | {
      playbackToken: string;
      ok: true;
    }
  | {
      body: { error: string };
      ok: false;
      statusCode: number;
    };

const resolveStreamAuthorization = async (
  req: SessionAuthRequest,
  userId: string,
  videoId: string,
): Promise<StreamAuthorization> => {
  const requestedToken = getRequestedPlaybackToken(req);

  if (requestedToken) {
    const claims = verifyPlaybackToken(requestedToken);

    if (
      !claims ||
      claims.videoId !== videoId ||
      claims.userId !== userId
    ) {
      return {
        ok: false,
        statusCode: 403,
        body: { error: 'Invalid or expired playback token' },
      };
    }

    return {
      ok: true,
      playbackToken: requestedToken,
    };
  }

  const videoWithOwner = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      userId: true,
      visibility: true,
      processingStatus: true,
      moderationStatus: true,
      user: {
        select: {
          isBanned: true,
        },
      },
    },
  });

  if (!videoWithOwner || videoWithOwner.userId !== userId) {
    return {
      ok: false,
      statusCode: 404,
      body: { error: 'Video not found' },
    };
  }

  if (
    !canBuildPlaybackUrls(videoWithOwner, {
      id: req.user?.id ?? null,
      role: req.user?.role ?? null,
    })
  ) {
    return {
      ok: false,
      statusCode: 403,
      body: { error: 'Access denied' },
    };
  }

  return {
    ok: true,
    playbackToken: createPlaybackToken({
      kind: 'playback',
      videoId,
      userId,
    }),
  };
};

async function proxyObject(
  bucket: string,
  objectName: string,
  playbackToken: string,
  res: Response,
) {
  try {
    if (objectName.endsWith('.m3u8')) {
      const playlist = await readObjectText(bucket, objectName);
      res.setHeader('Content-Type', `${contentTypeFor(objectName)}; charset=utf-8`);
      res.send(rewritePlaylistWithToken(playlist, playbackToken));
      return;
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
  optionalSessionAuthenticate,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId } = req.params;
    const authorization = await resolveStreamAuthorization(req, userId, videoId);

    if (!authorization.ok) {
      res.status(authorization.statusCode).json(authorization.body);
      return;
    }

    const objectName = hlsMasterIndex(userId, videoId);
    await proxyObject(
      BUCKETS.VIDEOS,
      objectName,
      authorization.playbackToken,
      res,
    );
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/master.m3u8',
  summary: 'Proxy HLS master playlist',
  description:
    'Backend proxy for the HLS master playlist. Clients should use the signed URL returned by GET /videos/:id. No Authorization header is required once the short-lived playback token is embedded in that URL. Note: userId must be the actual user ID (UUID), not username.',
  auth: false,
  params: { userId: 'User ID (UUID)', videoId: 'Video ID' },
  query: { token: 'Short-lived playback token returned by GET /videos/:id' },
});

router.get(
  '/videos/:userId/:videoId/:quality/index.m3u8',
  optionalSessionAuthenticate,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId, quality } = req.params;
    const authorization = await resolveStreamAuthorization(req, userId, videoId);

    if (!authorization.ok) {
      res.status(authorization.statusCode).json(authorization.body);
      return;
    }

    const objectName = hlsVariantIndex(userId, videoId, quality);
    await proxyObject(
      BUCKETS.VIDEOS,
      objectName,
      authorization.playbackToken,
      res,
    );
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/index.m3u8',
  summary: 'Proxy HLS variant playlist',
  description:
    'Backend proxy for an HLS variant playlist. Clients should use the signed URL returned by GET /videos/:id so the playlist can propagate the short-lived playback token to segment requests automatically.',
  auth: false,
  params: {
    userId: 'User ID (UUID)',
    videoId: 'Video ID',
    quality: 'Video quality (240p, 480p, 720p, 1080p)',
  },
  query: { token: 'Short-lived playback token returned by GET /videos/:id' },
});

router.get(
  '/videos/:userId/:videoId/:quality/:segment',
  optionalSessionAuthenticate,
  async (req: SessionAuthRequest, res: Response) => {
    const { userId, videoId, quality, segment } = req.params;
    const authorization = await resolveStreamAuthorization(req, userId, videoId);

    if (!authorization.ok) {
      res.status(authorization.statusCode).json(authorization.body);
      return;
    }

    const objectName = `${userId}/${videoId}/${quality}/${segment}`;
    await proxyObject(
      BUCKETS.VIDEOS,
      objectName,
      authorization.playbackToken,
      res,
    );
  },
);
registerRoute({
  method: 'GET',
  path: '/stream/videos/:userId/:videoId/:quality/:segment',
  summary: 'Proxy HLS segment (.ts)',
  description:
    'Backend proxy for HLS video segments. Requests are expected to carry the short-lived playback token propagated by the master and variant playlists returned from GET /videos/:id.',
  auth: false,
  params: {
    userId: 'User ID (UUID)',
    videoId: 'Video ID',
    quality: 'Video quality',
    segment: 'Segment filename',
  },
  query: { token: 'Short-lived playback token returned by GET /videos/:id' },
});

export default router;
