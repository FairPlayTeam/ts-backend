import type { RouteDoc } from '../registry.js';
import {
  multipartFormDataRequest,
  userMediaDeleteResponses,
  userMediaUploadResponses,
} from './shared.js';
import {
  deleteAvatarResponseSchema,
  deleteBannerResponseSchema,
  uploadAvatarBodySchema,
  uploadAvatarResponseSchema,
  uploadBannerBodySchema,
  uploadBannerResponseSchema,
} from '../../controllers/auth.schemas.js';
import {
  DELETE_AVATAR_SUCCESS_MESSAGE,
  DELETE_BANNER_SUCCESS_MESSAGE,
  UPLOAD_AVATAR_SUCCESS_MESSAGE,
  UPLOAD_BANNER_SUCCESS_MESSAGE,
} from '../../services/auth/auth.messages.js';

export const mediaRouteDocs = [
  {
    method: 'put',
    path: '/auth/me/avatar',
    summary: 'Upload or replace current user avatar',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: multipartFormDataRequest(uploadAvatarBodySchema),
    responses: userMediaUploadResponses(UPLOAD_AVATAR_SUCCESS_MESSAGE, uploadAvatarResponseSchema),
  },
  {
    method: 'delete',
    path: '/auth/me/avatar',
    summary: 'Delete current user avatar',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: userMediaDeleteResponses(DELETE_AVATAR_SUCCESS_MESSAGE, deleteAvatarResponseSchema),
  },
  {
    method: 'put',
    path: '/auth/me/banner',
    summary: 'Upload or replace current user banner',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    request: multipartFormDataRequest(uploadBannerBodySchema),
    responses: userMediaUploadResponses(UPLOAD_BANNER_SUCCESS_MESSAGE, uploadBannerResponseSchema),
  },
  {
    method: 'delete',
    path: '/auth/me/banner',
    summary: 'Delete current user banner',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    responses: userMediaDeleteResponses(DELETE_BANNER_SUCCESS_MESSAGE, deleteBannerResponseSchema),
  },
] satisfies RouteDoc[];
