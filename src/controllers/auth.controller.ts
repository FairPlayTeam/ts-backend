import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { toAuthHttpError } from './auth.errors.js';
import type {
  LoginRequestBody,
  LogoutSessionParams,
  RegisterRequestBody,
  RequestPasswordResetRequestBody,
  ResendVerificationRequestBody,
  ResetPasswordRequestBody,
  UpdateProfileRequestBody,
  UserSessionsQuery,
  VerifyEmailRequestBody,
} from './auth.schemas.js';
import type {
  AuthService,
  AuthSessionResult,
  ExportUserDataResult,
  ListUserSessionsResult,
  UserMediaAssetResult,
} from '../services/auth.types.js';

type AuthControllerDependencies = {
  authService: Omit<AuthService, 'cleanupExpiredAuthTokens' | 'cleanupSessions'>;
};

type SessionResponseInput = {
  id: string;
  expiresAt: Date;
};

const toIsoString = (date: Date): string => date.toISOString();

const toNullableIsoString = (date: Date | null): string | null => (date ? toIsoString(date) : null);

const toSessionResponse = (session: SessionResponseInput) => ({
  id: session.id,
  expiresAt: toIsoString(session.expiresAt),
});

const toAuthSessionResponse = (result: AuthSessionResult) => ({
  message: result.message,
  user: result.user,
  sessionKey: result.sessionKey,
  session: toSessionResponse(result.session),
});

const toUserSessionsResponse = ({ sessions, total, nextCursor }: ListUserSessionsResult) => ({
  sessions: sessions.map((session) => ({
    id: session.id,
    sessionKeySuffix: session.sessionKeySuffix,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    deviceInfo: session.deviceInfo,
    isCurrent: session.isCurrent,
    createdAt: toIsoString(session.createdAt),
    lastUsedAt: toIsoString(session.lastUsedAt),
    expiresAt: toIsoString(session.expiresAt),
  })),
  total,
  nextCursor: nextCursor
    ? {
        lastUsedAt: toIsoString(nextCursor.lastUsedAt),
        id: nextCursor.id,
      }
    : null,
});

type UserDataExportToken = NonNullable<ExportUserDataResult['emailVerificationToken']>;

const toUserDataExportTokenResponse = (token: UserDataExportToken | null) =>
  token
    ? {
        ...token,
        createdAt: toIsoString(token.createdAt),
        expiresAt: toIsoString(token.expiresAt),
      }
    : null;

const toUserDataExportResponse = (result: ExportUserDataResult) => ({
  exportedAt: toIsoString(result.exportedAt),
  user: {
    ...result.user,
    bannedAt: toNullableIsoString(result.user.bannedAt),
    createdAt: toIsoString(result.user.createdAt),
    updatedAt: toIsoString(result.user.updatedAt),
    lastLogin: toNullableIsoString(result.user.lastLogin),
  },
  sessions: result.sessions.map((session) => ({
    ...session,
    createdAt: toIsoString(session.createdAt),
    updatedAt: toIsoString(session.updatedAt),
    lastUsedAt: toIsoString(session.lastUsedAt),
    expiresAt: toIsoString(session.expiresAt),
  })),
  emailVerificationToken: toUserDataExportTokenResponse(result.emailVerificationToken),
  passwordResetToken: toUserDataExportTokenResponse(result.passwordResetToken),
});

const toPrettyJson = (body: unknown): string => JSON.stringify(body, null, 2) + '\n';

const toUserMediaAssetResponse = (asset: UserMediaAssetResult) => ({
  ...asset,
  updatedAt: toIsoString(asset.updatedAt),
});

export const createAuthController = (deps: AuthControllerDependencies) => {
  const register = async (
    req: Request<unknown, unknown, RegisterRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await deps.authService.register(req.body);

      return res.status(201).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const login = async (
    req: Request<unknown, unknown, LoginRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userAgent = req.get('user-agent');
      const result = await deps.authService.login({
        ...req.body,
        ipAddress: req.ip,
        userAgent,
      });

      return res.status(200).json(toAuthSessionResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const verifyEmail = async (
    req: Request<unknown, unknown, VerifyEmailRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const userAgent = req.get('user-agent');
      const result = await deps.authService.verifyEmail({
        ...req.body,
        ipAddress: req.ip,
        userAgent,
      });

      return res.status(200).json(toAuthSessionResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const resendVerification = async (
    req: Request<unknown, unknown, ResendVerificationRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await deps.authService.resendVerification(req.body);

      return res.status(200).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const me = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.getProfile({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        user: result.user,
        session: toSessionResponse(authenticatedReq.session),
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const exportMe = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.exportUserData({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
      });

      res.set('Content-Disposition', 'attachment; filename="fairplay-user-data-export.json"');

      return res
        .status(200)
        .type('application/json')
        .send(toPrettyJson(toUserDataExportResponse(result)));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const deleteMe = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.deleteAccount({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const sessions = async (
    req: Request<unknown, unknown, unknown, UserSessionsQuery>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const { limit, cursorLastUsedAt, cursorId } = req.query;
      const cursor =
        cursorLastUsedAt && cursorId
          ? {
              lastUsedAt: new Date(cursorLastUsedAt),
              id: cursorId,
            }
          : undefined;
      const result = await deps.authService.getUserSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });

      return res.status(200).json(toUserSessionsResponse(result));
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutAll = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutAllSessions({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutOthers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.logoutOtherSessions({
        userId: authenticatedReq.user.id,
        currentSessionId: authenticatedReq.session.id,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const logoutSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const { sessionId } = req.params as LogoutSessionParams;
      const result = await deps.authService.logoutSession({
        userId: authenticatedReq.user.id,
        sessionId,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const updateMe = async (
    req: Request<unknown, unknown, UpdateProfileRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;

      const result = await deps.authService.updateProfile({
        userId: authenticatedReq.user.id,
        ...req.body,
      });

      return res.status(200).json({
        message: result.message,
        user: result.user,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const uploadAvatar = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const file = req.file;
      const result = await deps.authService.uploadAvatar({
        userId: authenticatedReq.user.id,
        file: file
          ? {
              buffer: file.buffer,
              size: file.size,
            }
          : {
              buffer: Buffer.alloc(0),
              size: 0,
            },
      });

      return res.status(200).json({
        message: result.message,
        avatar: toUserMediaAssetResponse(result.avatar),
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const deleteAvatar = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const result = await deps.authService.deleteAvatar({
        userId: authenticatedReq.user.id,
      });

      return res.status(200).json({
        message: result.message,
        avatar: result.avatar,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const requestPasswordReset = async (
    req: Request<unknown, unknown, RequestPasswordResetRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { email } = req.body;

      const result = await deps.authService.requestPasswordReset({
        email,
      });

      return res.status(200).json({
        message: result.message,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  const resetPassword = async (
    req: Request<unknown, unknown, ResetPasswordRequestBody>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { token, password } = req.body;

      const result = await deps.authService.resetPassword({
        token,
        password,
      });

      return res.status(200).json({
        message: result.message,
        sessionsLoggedOut: result.sessionsLoggedOut,
      });
    } catch (err) {
      next(toAuthHttpError(err));
    }
  };

  return {
    register,
    login,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    resetPassword,
    me,
    exportMe,
    deleteMe,
    updateMe,
    uploadAvatar,
    deleteAvatar,
    sessions,
    logoutAll,
    logoutOthers,
    logoutSession,
  };
};
