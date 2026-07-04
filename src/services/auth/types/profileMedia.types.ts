export type UploadUserMediaInput = {
  userId: string;
  file: {
    buffer: Buffer;
    size: number;
  };
};

export type DeleteUserMediaInput = {
  userId: string;
};

export type UserMediaAssetResult = {
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: Date;
};

export type AuthProfileMediaPort = {
  uploadAvatar: (input: UploadUserMediaInput) => Promise<{
    message: string;
    avatar: UserMediaAssetResult;
  }>;
  deleteAvatar: (input: DeleteUserMediaInput) => Promise<{
    message: string;
    avatar: null;
  }>;
  uploadBanner: (input: UploadUserMediaInput) => Promise<{
    message: string;
    banner: UserMediaAssetResult;
  }>;
  deleteBanner: (input: DeleteUserMediaInput) => Promise<{
    message: string;
    banner: null;
  }>;
};
