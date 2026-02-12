import multer from 'multer';
import type { Request, RequestHandler } from 'express';
import crypto from 'node:crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const uploadTempDir = path.join(tmpdir(), 'fpbackend-uploads');
mkdirSync(uploadTempDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadTempDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max per file
  },
});

export const collectUploadedFiles = (req: Request): Express.Multer.File[] => {
  if (req.file) {
    return [req.file];
  }

  if (!req.files) {
    return [];
  }

  if (Array.isArray(req.files)) {
    return req.files;
  }

  return Object.values(req.files).flat();
};

const cleanupTempFiles = async (req: Request): Promise<void> => {
  const files = collectUploadedFiles(req);

  await Promise.all(
    files.map(async (file) => {
      if (!file.path) return;
      try {
        await fs.unlink(file.path);
      } catch (err: unknown) {
        const code =
          typeof err === 'object' && err !== null && 'code' in err
            ? String((err as { code?: string }).code)
            : '';
        if (code !== 'ENOENT') {
          console.error(`Failed to cleanup temp upload file ${file.path}`, err);
        }
      }
    }),
  );
};

const withTempFileCleanup = (middleware: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    let cleanedUp = false;
    const cleanupOnce = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void cleanupTempFiles(req);
    };

    res.once('finish', cleanupOnce);
    res.once('close', cleanupOnce);

    middleware(req, res, (err) => {
      if (err) {
        cleanupOnce();
      }
      next(err);
    });
  };
};

export const uploadFields = withTempFileCleanup(
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
);

export const uploadVideoBundle = withTempFileCleanup(
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]),
);

export const uploadSingle = (fieldName: string): RequestHandler =>
  withTempFileCleanup(upload.single(fieldName));
