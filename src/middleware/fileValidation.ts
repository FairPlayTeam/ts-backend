import { Request, Response, NextFunction } from 'express';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import { collectUploadedFiles } from './upload.js';

const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
];
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

export const validateFileMagicNumbers = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!req.file && !req.files) {
    return next();
  }

  const files: Express.Multer.File[] = collectUploadedFiles(req);

  for (const file of files) {
    const fileType = file.path
      ? await fileTypeFromFile(file.path)
      : file.buffer
        ? await fileTypeFromBuffer(file.buffer)
        : undefined;

    if (!fileType) {
      return res
        .status(400)
        .json({
          error: `Could not determine file type for ${file.originalname}. Upload rejected.`,
        });
    }

    const isVideoField = file.fieldname === 'video';
    const isImageField = ['thumbnail', 'avatar', 'banner'].includes(
      file.fieldname,
    );

    if (isVideoField && !ALLOWED_VIDEO_TYPES.includes(fileType.mime)) {
      return res
        .status(400)
        .json({
          error: `Invalid file type. Expected a video, but got ${fileType.mime}.`,
        });
    }

    if (isImageField && !ALLOWED_IMAGE_TYPES.includes(fileType.mime)) {
      return res
        .status(400)
        .json({
          error: `Invalid file type. Expected an image, but got ${fileType.mime}.`,
        });
    }
  }

  next();
};
