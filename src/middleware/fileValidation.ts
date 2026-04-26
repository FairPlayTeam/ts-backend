import { Request, Response, NextFunction } from 'express';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import { collectUploadedFiles } from './upload.js';
import path from 'node:path';
import {
    DIRECT_VIDEO_UPLOAD_MAX_BYTES,
    MAX_IMAGE_UPLOAD_BYTES,
    MAX_THUMBNAIL_BYTES,
} from '../lib/uploadConfig.js';

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
const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const MAX_FILES = 2;

const IMAGE_FIELDS = ['thumbnail', 'avatar', 'banner', 'ad'];

const getMaxImageBytes = (fieldName: string): number =>
    fieldName === 'thumbnail' ? MAX_THUMBNAIL_BYTES : MAX_IMAGE_UPLOAD_BYTES;

const getImageLabel = (fieldName: string): string =>
    fieldName === 'thumbnail' ? 'thumbnails' : 'images';

export const validateFileMagicNumbers = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (!req.file && !req.files) {
        return next();
    }

    const files: Express.Multer.File[] = collectUploadedFiles(req);

    if (files.length > MAX_FILES) {
        return res.status(400).json({ error: 'Too many files in a single request' });
    }

    for (const file of files) {
        const isVideoField = file.fieldname === 'video';
        const isImageField = IMAGE_FIELDS.includes(file.fieldname);

        if (!isVideoField && !isImageField) {
            return res.status(400).json({ error: `Unexpected field: ${file.fieldname}` });
        }

        const safeName = path.basename(file.originalname).replace(/[^\w.\-]/g, '_');

        if (isVideoField && file.size > DIRECT_VIDEO_UPLOAD_MAX_BYTES) {
            return res.status(413).json({ error: `File "${safeName}" exceeds the maximum allowed size for videos` });
        }
        if (isImageField && file.size > getMaxImageBytes(file.fieldname)) {
            return res.status(413).json({
                error: `File "${safeName}" exceeds the maximum allowed size for ${getImageLabel(file.fieldname)}`
            });
        }

        const ext = path.extname(file.originalname).toLowerCase();
        if (isVideoField && !ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ error: `Invalid video extension for "${safeName}"` });
        }
        if (isImageField && !ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ error: `Invalid image extension for "${safeName}"` });
        }


        const fileType = file.path
            ? await fileTypeFromFile(file.path)
            : file.buffer
                ? await fileTypeFromBuffer(file.buffer)
                : undefined

        if (!fileType) {
            return res.status(400).json({
                error: `Could not determine file type for "${safeName}". Upload rejected`
            });
        }

        if (isVideoField && !ALLOWED_VIDEO_TYPES.includes(fileType.mime)) {
            return res.status(400).json({
                error: `Invalid file type for "${safeName}". Expected a video, got ${fileType.mime}`
            });
        }

        if (isImageField && !ALLOWED_IMAGE_TYPES.includes(fileType.mime)) {
            return res.status(400).json({
                error: `Invalid file type for "${safeName}". Expected an image, got ${fileType.mime}`
            });
        }
    }

    next();
}
