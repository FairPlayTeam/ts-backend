export const USER_MEDIA_KINDS = ['avatar', 'banner'] as const;
export type UserMediaKind = (typeof USER_MEDIA_KINDS)[number];

export type UserMediaProcessingInput = {
  kind: UserMediaKind;
  file: {
    buffer: Buffer;
    size: number;
  };
};

export type ProcessedUserMedia = {
  buffer: Buffer;
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
};
