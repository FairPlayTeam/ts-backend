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

export type UploadAvatarInput = UploadUserMediaInput;

export type DeleteAvatarInput = DeleteUserMediaInput;

export type UploadBannerInput = UploadUserMediaInput;

export type DeleteBannerInput = DeleteUserMediaInput;

export type UserMediaAssetResult = {
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: Date;
};

export type AuthProfileMediaPort = {
  uploadAvatar: (input: UploadAvatarInput) => Promise<{
    message: string;
    avatar: UserMediaAssetResult;
  }>;
  deleteAvatar: (input: DeleteAvatarInput) => Promise<{
    message: string;
    avatar: null;
  }>;
  uploadBanner: (input: UploadBannerInput) => Promise<{
    message: string;
    banner: UserMediaAssetResult;
  }>;
  deleteBanner: (input: DeleteBannerInput) => Promise<{
    message: string;
    banner: null;
  }>;
};
