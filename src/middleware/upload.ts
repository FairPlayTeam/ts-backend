import multer from 'multer';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors/http.js';

export const UPLOAD_FILE_TOO_LARGE_MESSAGE = 'Uploaded file is too large';
export const UPLOAD_UNEXPECTED_FILE_MESSAGE = 'Unexpected uploaded file field';
export const UPLOAD_INVALID_REQUEST_MESSAGE = 'Invalid multipart upload request';

const MULTIPART_FIELD_NAME_MAX_BYTES = 64;
const MULTIPART_FIELD_VALUE_MAX_BYTES = 1024;
const MULTIPART_HEADER_PAIRS_MAX = 20;
const MULTIPART_PARTS_MAX = 2;

type SingleFileUploadOptions = {
  fieldName: string;
  maxFileSizeBytes: number;
};

const toUploadHttpError = (err: unknown): Error => {
  if (!(err instanceof multer.MulterError)) {
    return err instanceof Error
      ? err
      : new HttpError(400, 'BadRequest', UPLOAD_INVALID_REQUEST_MESSAGE);
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return new HttpError(413, 'PayloadTooLarge', UPLOAD_FILE_TOO_LARGE_MESSAGE, { cause: err });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return new HttpError(400, 'BadRequest', UPLOAD_UNEXPECTED_FILE_MESSAGE, { cause: err });
  }

  return new HttpError(400, 'BadRequest', UPLOAD_INVALID_REQUEST_MESSAGE, { cause: err });
};

export const createSingleFileUpload = ({
  fieldName,
  maxFileSizeBytes,
}: SingleFileUploadOptions): RequestHandler => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fieldNameSize: MULTIPART_FIELD_NAME_MAX_BYTES,
      fieldSize: MULTIPART_FIELD_VALUE_MAX_BYTES,
      fields: 0,
      fileSize: maxFileSizeBytes,
      files: 1,
      headerPairs: MULTIPART_HEADER_PAIRS_MAX,
      parts: MULTIPART_PARTS_MAX,
    },
  }).single(fieldName);

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (err) {
        next(toUploadHttpError(err));
        return;
      }

      next();
    });
  };
};
