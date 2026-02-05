import multer from 'multer';
import { Request } from 'express';

const storage = multer.memoryStorage();


export const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max but later change this to whatever
  },
});

export const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
  { name: 'avatar', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
]);

export const uploadVideoBundle = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);

export const uploadSingle = (fieldName: string) => upload.single(fieldName);
