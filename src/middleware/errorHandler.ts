import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import {
  MAX_IMAGE_UPLOAD_MB,
  MAX_THUMBNAIL_MB,
  VIDEO_CHUNK_MB,
} from '../lib/uploadConfig.js';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export const getPublicErrorMessage = (
  err: AppError,
  statusCode: number,
): string => {
  if (statusCode >= 500) {
    return 'Internal Server Error';
  }

  return err.message || 'Request failed';
};

const getMulterFileSizeMessage = (field?: string): string => {
  switch (field) {
    case 'thumbnail':
      return `Thumbnail is too large. Max size is ${MAX_THUMBNAIL_MB}MB.`;
    case 'avatar':
    case 'banner':
    case 'ad':
      return `Image is too large. Max size is ${MAX_IMAGE_UPLOAD_MB}MB.`;
    case 'chunk':
      return `Chunk is too large. Max size is ${VIDEO_CHUNK_MB}MB.`;
    case 'video':
      return 'Video file is too large for a single request. Please use chunked upload for large videos.';
    default:
      return 'Uploaded file exceeds the maximum allowed size.';
  }
};

const resolveMulterError = (
  err: multer.MulterError,
): { statusCode: number; message: string } => {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return { statusCode: 413, message: getMulterFileSizeMessage(err.field) };
    case 'LIMIT_FILE_COUNT':
      return { statusCode: 400, message: 'Too many files in a single request.' };
    case 'LIMIT_FIELD_COUNT':
      return { statusCode: 400, message: 'Too many fields in a single request.' };
    case 'LIMIT_UNEXPECTED_FILE':
      return {
        statusCode: 400,
        message: err.field ? `Unexpected file field: ${err.field}` : 'Unexpected file field.',
      };
    default:
      return { statusCode: 400, message: err.message || 'Invalid upload payload.' };
  }
};

export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const multerError = err instanceof multer.MulterError ? resolveMulterError(err) : null;
  const statusCode =
    multerError?.statusCode ??
    err.statusCode ??
    (err.message === 'CORS origin not allowed' ? 403 : 500);
  const message = multerError?.message ?? getPublicErrorMessage(err, statusCode);

  console.error(`Error ${statusCode}: ${err.message || 'Unknown error'}`);
  console.error(err.stack);

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    error: `Route ${req.originalUrl} not found`,
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
