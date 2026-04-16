import jwt, { type JwtPayload } from 'jsonwebtoken';
import { APP_SLUG } from './appInfo.js';

const DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS = 60 * 60;
const DEV_PLAYBACK_TOKEN_SECRET = `${APP_SLUG}-dev-playback-token-secret`;
const PLAYBACK_TOKEN_AUDIENCE = `${APP_SLUG}-playback`;

type PlaybackJwtClaims = {
  kind: 'playback';
  videoId: string;
  userId: string;
};

export type PlaybackTokenClaims = PlaybackJwtClaims;

export class PlaybackTokenConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybackTokenConfigurationError';
  }
}

const getPlaybackTokenSecret = (): string => {
  const secret = process.env.PLAYBACK_TOKEN_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV !== 'production') {
    return DEV_PLAYBACK_TOKEN_SECRET;
  }

  throw new PlaybackTokenConfigurationError(
    'PLAYBACK_TOKEN_SECRET is required in production',
  );
};

const getPlaybackTokenTtlSeconds = (): number => {
  const rawValue = Number(
    process.env.PLAYBACK_TOKEN_TTL_SECONDS ??
      DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS,
  );

  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    return DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS;
  }

  return rawValue;
};

const isPlaybackTokenClaims = (
  value: unknown,
): value is PlaybackTokenClaims & JwtPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const claims = value as Record<string, unknown>;

  return (
    claims.kind === 'playback' &&
    typeof claims.videoId === 'string' &&
    claims.videoId.length > 0 &&
    typeof claims.userId === 'string' &&
    claims.userId.length > 0
  );
};

export const createPlaybackToken = (
  claims: PlaybackJwtClaims,
): string =>
  jwt.sign(claims, getPlaybackTokenSecret(), {
    algorithm: 'HS256',
    audience: PLAYBACK_TOKEN_AUDIENCE,
    expiresIn: getPlaybackTokenTtlSeconds(),
    subject: claims.videoId,
  });

export const verifyPlaybackToken = (
  token: string,
): PlaybackTokenClaims | null => {
  try {
    const decoded = jwt.verify(token, getPlaybackTokenSecret(), {
      algorithms: ['HS256'],
      audience: PLAYBACK_TOKEN_AUDIENCE,
    });

    if (!isPlaybackTokenClaims(decoded)) {
      return null;
    }

    return {
      kind: decoded.kind,
      videoId: decoded.videoId,
      userId: decoded.userId,
    };
  } catch {
    return null;
  }
};
