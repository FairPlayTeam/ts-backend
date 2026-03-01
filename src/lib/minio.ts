import * as Minio from 'minio';
import { Readable } from 'stream';

const parseMinioUrl = (url: string) => {
  const urlObj = new URL(url);
  return {
    endPoint: urlObj.hostname,
    port: parseInt(urlObj.port) || 9000,
    useSSL: urlObj.protocol === 'https:',
    accessKey: urlObj.username,
    secretKey: urlObj.password,
  };
};

const minioConfig = parseMinioUrl(process.env.MINIO_URL!);

export const minioClient = new Minio.Client(minioConfig);

export const BUCKETS = {
  VIDEOS: 'videos',
  USERS: 'users',
} as const;

export const initializeBuckets = async (): Promise<void> => {
  try {
    for (const bucketName of Object.values(BUCKETS)) {
      let exists = false;
      try {
        exists = await minioClient.bucketExists(bucketName);
      } catch (error) {
        console.error('Failed to check if bucket exists:', error);
      }

      if (!exists) {
        try {
          await minioClient.makeBucket(bucketName);
          console.log(`Created bucket: ${bucketName}`);
        } catch (error: any) {
          const code = error?.code || error?.name || '';
          if (
            code === 'BucketAlreadyOwnedByYou' ||
            code === 'BucketAlreadyExists'
          ) {
            console.warn(`Bucket ${bucketName} already exists; continuing`);
          } else {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    console.error('Error initializing MinIO buckets:', error);
    throw error;
  }
};

export const uploadFile = async (
  bucketName: string,
  objectName: string,
  stream: Buffer | Readable,
  size?: number,
  metaData?: Record<string, string>,
): Promise<string> => {
  try {
    await minioClient.putObject(bucketName, objectName, stream, size, metaData);
    return `${bucketName}/${objectName}`;
  } catch (error) {
    console.error('Error uploading file to MinIO:', error);
    throw error;
  }
};

export const getFileUrl = async (
  bucketName: string,
  objectName: string,
  expiry: number = 24 * 60 * 60,
): Promise<string> => {
  try {
    return await minioClient.presignedGetObject(bucketName, objectName, expiry);
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
};
