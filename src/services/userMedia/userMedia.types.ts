export type UserMediaKind = 'avatar' | 'banner';

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
