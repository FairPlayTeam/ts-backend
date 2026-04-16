import ffmpeg from 'fluent-ffmpeg';
import { VideoProcessingStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { minioClient, BUCKETS } from './minio.js';
import { prisma } from './prisma.js';
import { hlsVariantDir, hlsMasterIndex } from './paths.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    VideoQuality,
    VIDEO_QUALITIES,
    selectQualitiesForSource,
} from './videoProfiles.js';
import { APP_SLUG } from './appInfo.js';

export interface ProcessingJob {
    videoId: string;
    userId: string;
    originalPath: string;
    qualities: VideoQuality[];
}

const processingQueue: ProcessingJob[] = [];
const activeJobs = new Map<string, boolean>();
let activeJobsCount = 0;

const MAX_CONCURRENT_JOBS = 1;
const MINIO_UPLOAD_CONCURRENCY = 5;
const VIDEO_PROCESSING_ROOT = path.join(tmpdir(), `${APP_SLUG}-video-processing`);

const getVideoProcessingDir = (videoId: string): string =>
    path.join(VIDEO_PROCESSING_ROOT, videoId);

const isQueued = (videoId: string): boolean =>
    processingQueue.some((job) => job.videoId === videoId);

export const addToProcessingQueue = (job: ProcessingJob): void => {
    if (activeJobs.has(job.videoId) || isQueued(job.videoId)) {
        return;
    }

    processingQueue.push(job);
    processNextJob();
};

export const resumePendingVideoProcessing = async (): Promise<void> => {
    try {
        const resumableStatuses = [
            VideoProcessingStatus.uploading,
            VideoProcessingStatus.processing,
        ] as const;

        const unrecoverable = await prisma.video.updateMany({
            where: {
                processingStatus: { in: [...resumableStatuses] },
                storagePath: null,
            },
            data: {
                processingStatus: VideoProcessingStatus.failed,
            },
        });

        if (unrecoverable.count > 0) {
            console.warn(
                `Marked ${unrecoverable.count} video(s) as failed because their original upload path is missing.`,
            );
        }

        const pendingVideos = await prisma.video.findMany({
            where: {
                processingStatus: { in: [...resumableStatuses] },
                storagePath: { not: null },
            },
            select: {
                id: true,
                userId: true,
                storagePath: true,
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        for (const video of pendingVideos) {
            addToProcessingQueue({
                videoId: video.id,
                userId: video.userId,
                originalPath: video.storagePath!,
                qualities: VIDEO_QUALITIES,
            });
        }

        if (pendingVideos.length > 0) {
            console.log(`Resumed ${pendingVideos.length} pending video processing job(s)`);
        }
    } catch (error) {
        console.error('Failed to resume pending video processing:', error);
    }
};

const processNextJob = async (): Promise<void> => {
    if (activeJobsCount >= MAX_CONCURRENT_JOBS || processingQueue.length === 0) return;

    const job = processingQueue.shift();
    if (!job || activeJobs.has(job.videoId)) return;

    activeJobsCount++;
    activeJobs.set(job.videoId, true);

    try {
        await updateProcessingStatus(job.videoId, VideoProcessingStatus.processing);
        const processedVideo = await processVideoQualities(job);
        const variants = processedVideo.qualities.map((q) => ({
            name: q.name,
            bandwidth: parseBitrate(q.bitrate),
            resolution: `${q.actualWidth}x${q.height}`
        }));
        await createAndUploadMasterPlaylist(job.userId, job.videoId, variants);
        await markProcessingCompleted(
            job.videoId,
            processedVideo.qualities,
            processedVideo.duration,
        );
        await deleteOriginalUpload(job.videoId, job.originalPath);
    } catch (error) {
        console.error(`Video processing failed: ${job.videoId}`, error);
        await updateProcessingStatus(job.videoId, VideoProcessingStatus.failed).catch(() => {});
    } finally {
        activeJobsCount--;
        activeJobs.delete(job.videoId);
        processNextJob();
    }
};

const parseBitrate = (bitrate: string): number => {
    const lower = bitrate.toLowerCase();
    if (lower.endsWith('k')) return parseFloat(lower) * 1_000;
    if (lower.endsWith('m')) return parseFloat(lower) * 1_000_000;
    return parseInt(lower) || 1_000_000;
};

type ProcessedQuality = VideoQuality & { actualWidth: number }

type ProcessedVideo = {
    duration: number;
    qualities: ProcessedQuality[];
};

const processVideoQualities = async (
    job: ProcessingJob
): Promise<ProcessedVideo> => {
    const tempDir = getVideoProcessingDir(job.videoId);
    const originalFile = path.join(tempDir, 'original.mp4');

    await fs.mkdir(tempDir, { recursive: true });

    try {
        await downloadFromMinio(job.originalPath, originalFile);

        await generateAndUploadThumbnail(job, originalFile, tempDir);

        const videoInfo = await getVideoInfo(originalFile);
        if (videoInfo.width <= 0 || videoInfo.height <= 0) {
            throw new Error('Invalid video dimensions');
        }

        const maxHeight = videoInfo.height;
        const hasAudio = videoInfo.hasAudio;
        const aspectRatio = videoInfo.width / videoInfo.height;

        const qualitiesToProcess = selectQualitiesForSource(maxHeight, job.qualities);
        if (qualitiesToProcess.length === 0) {
            throw new Error('No video quality profiles available for processing');
        }

        const qualities = await pLimit(
            qualitiesToProcess.map((quality) => async () => {
                const actualWidth = Math.max(
                    2,
                    Math.round((quality.height * aspectRatio) / 2) * 2,
                );
                return processQuality(job, originalFile, quality, hasAudio, actualWidth);
            }),
            2
        );

        return {
            duration: videoInfo.duration,
            qualities,
        };
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
            console.error(`Failed to clean temp dir ${tempDir}:`, err);
        });
    }
};

async function pLimit<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let index = 0;

    async function worker(): Promise<void> {
        while (index < tasks.length) {
            const i = index++;
            results[i] = await tasks[i]();
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
};

const processQuality = async (
    job: ProcessingJob,
    inputFile: string,
    quality: VideoQuality,
    hasAudio: boolean,
    actualWidth: number
): Promise<ProcessedQuality> => {
    const outDir = path.join(getVideoProcessingDir(job.videoId), quality.name);
    await fs.mkdir(outDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
        const cmd = ffmpeg(inputFile)
            .videoCodec('libx264')
            .size(`${actualWidth}x${quality.height}`)
            .videoBitrate(quality.bitrate)
            .outputOptions([
                '-map', '0:v:0',
                '-map', '0:a:0?',
                '-preset', 'veryfast',
                `-crf`, String(quality.crf),
                `-maxrate`, quality.bitrate,
                `-bufsize`, String(parseBitrate(quality.bitrate) * 2),
                '-movflags', '+faststart',
                '-hls_time', '6',
                '-hls_playlist_type', 'vod',
                '-hls_segment_filename', path.join(outDir, 'segment_%03d.ts')
            ])
            .format('hls')
            .on('end', () => resolve())
            .on('error', reject);

        if (hasAudio) {
            cmd.audioCodec('aac').audioBitrate('128k').audioChannels(2).audioFrequency(44100);
        } else {
            cmd.noAudio();
        }

        cmd.save(path.join(outDir, 'index.m3u8'));
    })

    const objectPrefix = hlsVariantDir(job.userId, job.videoId, quality.name);
    const files = await fs.readdir(outDir);

    await pLimit(
        files.map((file) => async () => {
            const localPath = path.join(outDir, file);
            const objectPath = `${objectPrefix}/${file}`;
            await uploadToMinioStream(localPath, `${BUCKETS.VIDEOS}/${objectPath}`);
        }),
        MINIO_UPLOAD_CONCURRENCY
    );

    return { ...quality, actualWidth };
};

const getVideoInfo = (
    filePath: string
): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) return reject(error);
            const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
            if (!videoStream) return reject(new Error('No video stream found'));
            const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
            resolve({
                width: videoStream.width || 0,
                height: videoStream.height || 0,
                duration: metadata.format.duration || 0,
                hasAudio: Boolean(audioStream),
            });
        });
    });
};

const downloadFromMinio = async (minioPath: string, localPath: string): Promise<void> => {
    const [bucket, ...pathParts] = minioPath.split('/');
    const objectName = pathParts.join('/');
    await minioClient.fGetObject(bucket, objectName, localPath);
};

const uploadToMinioStream = async (localPath: string, minioPath: string): Promise<void> => {
    const [bucket, ...pathParts] = minioPath.split('/');
    const objectName = pathParts.join('/');
    const stat = await fs.stat(localPath);
    const stream = createReadStream(localPath);
    await minioClient.putObject(bucket, objectName, stream, stat.size);
};

const uploadToMinio = async (localPath: string, minioPath: string): Promise<void> => {
    await uploadToMinioStream(localPath, minioPath);
};

const deleteFromMinio = async (minioPath: string): Promise<void> => {
    const [bucket, ...pathParts] = minioPath.split('/');
    const objectName = pathParts.join('/');
    await minioClient.removeObject(bucket, objectName);
};

const deleteOriginalUpload = async (videoId: string, minioPath: string): Promise<void> => {
    try {
        await deleteFromMinio(minioPath);
        await prisma.video.update({
            where: { id: videoId },
            data: { storagePath: null },
        });
    } catch (error) {
        console.error(`Failed to cleanup original upload for video ${videoId}:`, error);
    }
};

const updateProcessingStatus = async (
    videoId: string,
    processingStatus: VideoProcessingStatus
): Promise<void> => {
    await prisma.video.update({
        where: { id: videoId },
        data: { processingStatus }
    });
};

const markProcessingCompleted = async (
    videoId: string,
    qualities: ProcessedQuality[],
    duration: number,
): Promise<void> => {
    await prisma.video.update({
        where: { id: videoId },
        data: {
            processingStatus: VideoProcessingStatus.done,
            duration: Number.isFinite(duration) && duration >= 0
                ? Math.round(duration)
                : null,
            publishedAt: new Date(),
            qualities: qualities.map((quality) => ({
                name: quality.name,
                height: quality.height,
                width: quality.actualWidth,
                bitrate: quality.bitrate,
            })),
        },
    });
};

export const generateVideoId = (): string => uuidv4();

const createAndUploadMasterPlaylist = async (
    userId: string,
    videoId: string,
    variants: { name: string; bandwidth: number; resolution: string }[]
): Promise<void> => {
    const tempDir = getVideoProcessingDir(videoId);
    await fs.mkdir(tempDir, { recursive: true });
    const masterPath = path.join(tempDir, 'master.m3u8');

    const lines: string[] = ['#EXTM3U'];
    for (const v of variants) {
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`);
        lines.push(`${v.name}/index.m3u8`);
    }
    await fs.writeFile(masterPath, lines.join('\n'), 'utf8');

    await uploadToMinio(masterPath, `${BUCKETS.VIDEOS}/${hlsMasterIndex(userId, videoId)}`);
};

const generateAndUploadThumbnail = async (
    job: ProcessingJob,
    inputFile: string,
    tempDir: string
): Promise<void> => {
    try {
        const existing = await prisma.video.findUnique({
            where: { id: job.videoId },
            select: { thumbnail: true }
        });
        if (existing?.thumbnail) return;

        const thumbnailFile = `thumbnail-${uuidv4()}.jpg`;
        const tempThumbnailPath = path.join(tempDir, thumbnailFile);

        await new Promise<void>((resolve, reject) => {
            ffmpeg(inputFile)
                .on('end', () => resolve())
                .on('error', (error) => reject(new Error(`Thumbnail generation failed: ${error.message}`)))
                .outputOptions(['-vf', 'scale=640:-2', '-frames:v', '1', '-ss', '00:00:01'])
                .save(tempThumbnailPath)
        });

        const minioThumbnailPath = `thumbnails/${job.userId}/${job.videoId}/${thumbnailFile}`;
        await uploadToMinioStream(tempThumbnailPath, `${BUCKETS.VIDEOS}/${minioThumbnailPath}`);

        await prisma.video.update({
            where: { id: job.videoId },
            data: { thumbnail: minioThumbnailPath }
        });
    } catch (error) {
        console.error(`Failed to generate thumbnail for video ${job.videoId}:`, error);
    }
}
