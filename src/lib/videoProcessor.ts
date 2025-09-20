import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { minioClient, BUCKETS } from './minio.js';
import { prisma } from './prisma.js';
import { Readable } from 'stream';
import {
  hlsVariantDir,
  hlsVariantIndex,
  hlsVariantSegment,
  hlsMasterIndex,
} from './paths.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface VideoQuality {
  name: string;
  height: number;
  bitrate: string;
}

export const VIDEO_QUALITIES: VideoQuality[] = [
  { name: '240p', height: 240, bitrate: '400k' },
  { name: '480p', height: 480, bitrate: '800k' },
  { name: '720p', height: 720, bitrate: '2000k' },
  { name: '1080p', height: 1080, bitrate: '4000k' },
];

export interface ProcessingJob {
  videoId: string;
  userId: string;
  originalPath: string;
  qualities: VideoQuality[];
}

const processingQueue: ProcessingJob[] = [];
const activeJobs = new Map<string, boolean>();

export const addToProcessingQueue = (job: ProcessingJob): void => {
  processingQueue.push(job);
  processNextJob();
};

const processNextJob = async (): Promise<void> => {
  if (processingQueue.length === 0) return;

  const job = processingQueue.shift();
  if (!job || activeJobs.has(job.videoId)) return;

  activeJobs.set(job.videoId, true);

  try {
    await updateProcessingStatus(job.videoId, 'processing');
    const processed = await processVideoQualities(job);
    const variants = processed.map((q) => ({
      name: q.name,
      bandwidth: parseInt(q.bitrate) * 1000 || 1000000,
      resolution: `1280x${q.height}`,
    }));
    await createAndUploadMasterPlaylist(job.userId, job.videoId, variants);
    await updateProcessingStatus(job.videoId, 'done');
    await deleteFromMinio(job.originalPath);
    console.log(`Video processing completed: ${job.videoId}`);
  } catch (error) {
    console.error(`Video processing failed: ${job.videoId}`, error);
  } finally {
    activeJobs.delete(job.videoId);
    processNextJob();
  }
};

const processVideoQualities = async (
  job: ProcessingJob,
): Promise<VideoQuality[]> => {
  const tempDir = `/tmp/video-processing/${job.videoId}`;
  const originalFile = `${tempDir}/original.mp4`;

  await downloadFromMinio(job.originalPath, originalFile);

  const videoInfo = await getVideoInfo(originalFile);
  const maxHeight = videoInfo.height;

  const qualitiesToProcess = job.qualities.filter((q) => q.height <= maxHeight);

  const processPromises = qualitiesToProcess.map((quality) =>
    processQuality(job, originalFile, quality),
  );

  await Promise.all(processPromises);
  return qualitiesToProcess;
};

const processQuality = async (
  job: ProcessingJob,
  inputFile: string,
  quality: VideoQuality,
): Promise<void> => {
  const outDir = `/tmp/video-processing/${job.videoId}/${quality.name}`;
  await fs.mkdir(outDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputFile)
      .videoCodec('libx264')
      .audioCodec('aac')
      .size(`?x${quality.height}`)
      .videoBitrate(quality.bitrate)
      .audioBitrate('128k')
      .outputOptions([
        '-preset',
        'veryfast',
        '-movflags',
        '+faststart',
        '-hls_time',
        '6',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(outDir, 'segment_%03d.ts'),
      ])
      .format('hls')
      .on('end', () => resolve())
      .on('error', reject)
      .save(path.join(outDir, 'index.m3u8'));
  });

  const objectPrefix = hlsVariantDir(job.userId, job.videoId, quality.name);
  const files = await fs.readdir(outDir);
  for (const file of files) {
    const localPath = path.join(outDir, file);
    const objectPath = `${objectPrefix}/${file}`;
    await uploadToMinio(localPath, `${BUCKETS.VIDEOS}/${objectPath}`);
  }
};

const getVideoInfo = (
  filePath: string,
): Promise<{ width: number; height: number; duration: number }> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find(
        (s) => s.codec_type === 'video',
      );
      if (!videoStream) return reject(new Error('No video stream found'));

      resolve({
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        duration: metadata.format.duration || 0,
      });
    });
  });
};

const downloadFromMinio = async (
  minioPath: string,
  localPath: string,
): Promise<void> => {
  const [bucket, ...pathParts] = minioPath.split('/');
  const objectName = pathParts.join('/');

  try {
    await minioClient.fGetObject(bucket, objectName, localPath);
  } catch (error) {
    throw error;
  }
};

const uploadToMinio = async (
  localPath: string,
  minioPath: string,
): Promise<void> => {
  const [bucket, ...pathParts] = minioPath.split('/');
  const objectName = pathParts.join('/');

  try {
    await minioClient.fPutObject(bucket, objectName, localPath);
  } catch (error) {
    throw error;
  }
};

const deleteFromMinio = async (minioPath: string): Promise<void> => {
  const [bucket, ...pathParts] = minioPath.split('/');
  const objectName = pathParts.join('/');
  try {
    await minioClient.removeObject(bucket, objectName);
  } catch (_) {}
};

const updateProcessingStatus = async (
  videoId: string,
  processingStatus: 'uploading' | 'processing' | 'done',
): Promise<void> => {
  await prisma.video.update({
    where: { id: videoId },
    data: {
      processingStatus,
    } as any,
  });
};

export const generateVideoId = (): string => {
  return uuidv4();
};

const createAndUploadMasterPlaylist = async (
  userId: string,
  videoId: string,
  variants: { name: string; bandwidth: number; resolution: string }[],
): Promise<void> => {
  const tempDir = `/tmp/video-processing/${videoId}`;
  await fs.mkdir(tempDir, { recursive: true });
  const masterPath = path.join(tempDir, 'master.m3u8');

  const lines: string[] = ['#EXTM3U'];
  for (const v of variants) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`,
    );
    lines.push(`${v.name}/index.m3u8`);
  }
  await fs.writeFile(masterPath, lines.join('\n'), 'utf8');

  await uploadToMinio(
    masterPath,
    `${BUCKETS.VIDEOS}/${hlsMasterIndex(userId, videoId)}`,
  );
};
