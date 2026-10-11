export type VideoProbe = {
  width: number;
  height: number;
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
  hasAudio: boolean;
};

export type VideoTranscodeLimits = {
  ffmpegTimeoutMs: number;
  ffprobeTimeoutMs: number;
  maxArtifactBytes: number;
  maxAspectRatio: number;
  maxDurationSeconds: number;
  maxFps: number;
  maxHeight: number;
  maxPixels: number;
  maxWidth: number;
};

export type GeneratedVideoArtifact = {
  objectKey: string;
  filePath: string;
  contentType: string;
  sizeBytes: number;
};

export type GeneratedVideoArtifacts = {
  files: GeneratedVideoArtifact[];
  renditionSegments: GeneratedVideoArtifact[][];
};

export type ClaimedVideoTranscodeJob = {
  id: string;
  videoId: string;
  sourceObjectKey: string;
  attempts: number;
  maxAttempts: number;
  executionId: string;
};

export type ReservedArtifactGeneration = {
  id: string;
  publicToken: string;
  sourceUploadSessionId: string;
  userId: string;
  bucket: string;
};

export class VideoTranscodeOwnershipLostError extends Error {
  constructor() {
    super('Video transcode job ownership was lost');
    this.name = 'VideoTranscodeOwnershipLostError';
  }
}

export class VideoTranscodeSourceNotCurrentError extends Error {
  constructor() {
    super('Video transcode source is no longer current');
    this.name = 'VideoTranscodeSourceNotCurrentError';
  }
}

export class VideoTranscodeRunnerShutdownError extends Error {
  constructor() {
    super('Video transcode runner is shutting down');
    this.name = 'VideoTranscodeRunnerShutdownError';
  }
}

export class VideoProcessExecutionError extends Error {
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;

  constructor(
    command: string,
    exitCode: number | null,
    terminationSignal: NodeJS.Signals | null,
    stderr: string,
  ) {
    const detail = stderr.trim();
    const termination = terminationSignal
      ? `was terminated by ${terminationSignal}`
      : `exited with code ${exitCode === null ? 'unknown' : String(exitCode)}`;
    super(`${command} ${termination}${detail ? `: ${detail}` : ''}`);
    this.name = 'VideoProcessExecutionError';
    this.exitCode = exitCode;
    this.terminationSignal = terminationSignal;
  }
}

export class VideoProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = 'VideoProcessTimeoutError';
  }
}

export class InvalidVideoSourceError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'InvalidVideoSourceError';
  }
}

export class VideoSourceLimitExceededError extends InvalidVideoSourceError {
  constructor(detail: string) {
    super(`Source video exceeds transcode limits: ${detail}`);
    this.name = 'VideoSourceLimitExceededError';
  }
}

export class VideoSourceResolutionTooLowError extends InvalidVideoSourceError {
  constructor(height: number) {
    super(`Source video display height ${height}px is below the minimum supported height of 240px`);
    this.name = 'VideoSourceResolutionTooLowError';
  }
}

export class VideoArtifactSizeExceededError extends Error {
  constructor(maxArtifactBytes: number) {
    super(`Generated video artifacts exceed the ${maxArtifactBytes}-byte limit`);
    this.name = 'VideoArtifactSizeExceededError';
  }
}

export type VideoTranscodingMaintenancePort = {
  scheduleAbandonedArtifactGenerations(input: { observedAt: Date }): Promise<{
    artifactGenerationsScheduled: number;
  }>;
};
