import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { minioClient } from '../lib/minio.js';
import { registerRoute } from '../lib/docs.js';
import { optionalSessionAuthenticate } from '../lib/sessionAuth.js';

const router = Router();

function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

async function proxyUserAsset(
  bucket: string,
  objectName: string,
  userId: string,
  requesterId: string | null,
  res: Response,
) {
  try {
    console.log(`[Asset Proxy] Attempting to fetch: bucket=${bucket}, objectName=${objectName}, userId=${userId}`);
    
    // Find the user to check if they exist and if their profile is accessible
    const user = await prisma.user.findUnique({ 
      where: { id: userId },
      select: { 
        id: true, 
        isBanned: true,
        isActive: true 
      }
    });

    if (!user) {
      console.log(`[Asset Proxy] User not found: ${userId}`);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[Asset Proxy] User found, fetching from MinIO...`);
    
    // For now, allow access to all user assets (avatars/banners are generally public)
    // You could add privacy controls here later if needed
    
    const stream = await minioClient.getObject(bucket, objectName);
    res.setHeader('Content-Type', contentTypeFor(objectName));
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    stream.on('error', (err) => {
      console.error(`[Asset Proxy] Stream error:`, err);
      if (!res.headersSent) res.status(500);
      res.end(String(err));
    });
    stream.pipe(res);
  } catch (err: any) {
    console.error(`[Asset Proxy] Error:`, err);
    const status = err?.code === 'NoSuchKey' ? 404 : 500;
    res.status(status).json({ error: 'Failed to fetch asset', details: err.message });
  }
}

// Avatar proxy route
router.get(
  '/users/:userId/avatar/:filename',
  optionalSessionAuthenticate,
  async (req: Request, res: Response) => {
    const { userId, filename } = req.params;
    const requesterId = (req as any).user?.id || null;
    
    // Get the actual avatar path from the database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true }
    });
    
    if (!user || !user.avatarUrl) {
      return res.status(404).json({ error: 'Avatar not found' });
    }
    
    await proxyUserAsset(
      'users',
      user.avatarUrl, // Use the exact path from database
      userId,
      requesterId,
      res,
    );
  },
);

registerRoute({
  method: 'GET',
  path: '/assets/users/:userId/avatar/:filename',
  summary: 'Proxy user avatar image',
  description:
    'Backend proxy for user avatar images. Consumed by frontend; usually not called directly by users.',
  params: {
    userId: 'User ID (UUID)',
    filename: 'Avatar filename (e.g., avatar.jpg)',
  },
});

// Banner proxy route
router.get(
  '/users/:userId/banner/:filename',
  optionalSessionAuthenticate,
  async (req: Request, res: Response) => {
    const { userId, filename } = req.params;
    const requesterId = (req as any).user?.id || null;
    
    // Get the actual banner path from the database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { bannerUrl: true }
    });
    
    if (!user || !user.bannerUrl) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    await proxyUserAsset(
      'users',
      user.bannerUrl, // Use the exact path from database
      userId,
      requesterId,
      res,
    );
  },
);

registerRoute({
  method: 'GET',
  path: '/assets/users/:userId/banner/:filename',
  summary: 'Proxy user banner image',
  description:
    'Backend proxy for user banner images. Consumed by frontend; usually not called directly by users.',
  params: {
    userId: 'User ID (UUID)',
    filename: 'Banner filename (e.g., banner.jpg)',
  },
});

export default router;
