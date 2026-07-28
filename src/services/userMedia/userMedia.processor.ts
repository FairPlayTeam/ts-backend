import { fileTypeFromBuffer } from 'file-type';
import sharp from '../../lib/sharp.js';
import {
  AVATAR_IMAGE_SIZE_PX,
  BANNER_IMAGE_HEIGHT_PX,
  BANNER_IMAGE_WIDTH_PX,
  VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
  VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
} from '../../config/constants.js';
import {
  UserMediaFileRequiredError,
  UserMediaFileTooLargeError,
  UserMediaInvalidImageError,
  UserMediaUnsupportedTypeError,
} from './userMedia.errors.js';
import type {
  ProcessedUserMedia,
  UserMediaKind,
  UserMediaProcessingInput,
} from './userMedia.types.js';

const ACCEPTED_INPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AVATAR_MAX_INPUT_PIXELS = 16_000_000;

type UserMediaPolicy = {
  width: number;
  height: number;
  fit: 'cover';
  maxUploadBytes: number;
  maxInputPixels: number;
  webpQuality: number;
};

export type UserMediaProcessor = {
  process(input: UserMediaProcessingInput): Promise<ProcessedUserMedia>;
  processVideoThumbnail(file: UserMediaProcessingInput['file']): Promise<ProcessedUserMedia>;
};

export type UserMediaProcessorConfig = {
  profileMediaMaxUploadBytes: number;
};

const createUserMediaPolicies = ({
  profileMediaMaxUploadBytes,
}: UserMediaProcessorConfig): Record<UserMediaKind, UserMediaPolicy> => ({
  avatar: {
    width: AVATAR_IMAGE_SIZE_PX,
    height: AVATAR_IMAGE_SIZE_PX,
    fit: 'cover',
    maxUploadBytes: profileMediaMaxUploadBytes,
    maxInputPixels: AVATAR_MAX_INPUT_PIXELS,
    webpQuality: 82,
  },
  banner: {
    width: BANNER_IMAGE_WIDTH_PX,
    height: BANNER_IMAGE_HEIGHT_PX,
    fit: 'cover',
    maxUploadBytes: profileMediaMaxUploadBytes,
    maxInputPixels: 24_000_000,
    webpQuality: 82,
  },
});

const createVideoThumbnailPolicy = ({
  profileMediaMaxUploadBytes,
}: UserMediaProcessorConfig): UserMediaPolicy => ({
  width: VIDEO_SOURCE_THUMBNAIL_WIDTH_PX,
  height: VIDEO_SOURCE_THUMBNAIL_HEIGHT_PX,
  fit: 'cover',
  maxUploadBytes: profileMediaMaxUploadBytes,
  maxInputPixels: AVATAR_MAX_INPUT_PIXELS,
  webpQuality: 82,
});

const assertProcessableFile = async (
  file: UserMediaProcessingInput['file'],
  policy: UserMediaPolicy,
): Promise<void> => {
  if (file.size <= 0 || file.buffer.length <= 0) {
    throw new UserMediaFileRequiredError();
  }

  if (file.size > policy.maxUploadBytes || file.buffer.length > policy.maxUploadBytes) {
    throw new UserMediaFileTooLargeError();
  }

  const fileType = await fileTypeFromBuffer(file.buffer);

  if (!fileType || !ACCEPTED_INPUT_MIME_TYPES.has(fileType.mime)) {
    throw new UserMediaUnsupportedTypeError();
  }
};

const processImage = async (
  file: UserMediaProcessingInput['file'],
  policy: UserMediaPolicy,
): Promise<ProcessedUserMedia> => {
  try {
    const { data, info } = await sharp(file.buffer, {
      failOn: 'truncated',
      limitInputPixels: policy.maxInputPixels,
    })
      .rotate()
      .resize({
        width: policy.width,
        height: policy.height,
        fit: policy.fit,
        position: 'centre',
        // Every normalized media kind keeps its configured fixed output dimensions.
        withoutEnlargement: false,
      })
      .webp({
        quality: policy.webpQuality,
        effort: 4,
      })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      mimeType: 'image/webp',
      sizeBytes: data.length,
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    throw new UserMediaInvalidImageError(undefined, { cause: err });
  }
};

export const createUserMediaProcessor = (config: UserMediaProcessorConfig): UserMediaProcessor => {
  const policies = createUserMediaPolicies(config);
  const videoThumbnailPolicy = createVideoThumbnailPolicy(config);

  return {
    async process(input: UserMediaProcessingInput) {
      const policy = policies[input.kind];
      await assertProcessableFile(input.file, policy);

      return processImage(input.file, policy);
    },
    async processVideoThumbnail(file) {
      await assertProcessableFile(file, videoThumbnailPolicy);

      return processImage(file, videoThumbnailPolicy);
    },
  };
};
