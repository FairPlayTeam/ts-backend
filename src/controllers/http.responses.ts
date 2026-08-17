import type { Response } from 'express';

const SENSITIVE_RESPONSE_CACHE_CONTROL = 'no-store';
const PUBLIC_MEDIA_CROSS_ORIGIN_RESOURCE_POLICY = 'cross-origin';

export const toIsoString = (date: Date): string => date.toISOString();

export const toNullableIsoString = (date: Date | null): string | null =>
  date ? toIsoString(date) : null;

export const setNoStore = (res: Response): Response =>
  res.set('Cache-Control', SENSITIVE_RESPONSE_CACHE_CONTROL);

export const allowPublicCrossOriginMedia = (res: Response): Response =>
  res.set('Cross-Origin-Resource-Policy', PUBLIC_MEDIA_CROSS_ORIGIN_RESOURCE_POLICY);

export const sendNoStoreJson = (res: Response, statusCode: number, body: unknown): Response =>
  setNoStore(res).status(statusCode).json(body);
