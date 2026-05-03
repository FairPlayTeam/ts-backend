export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const isHttpError = (err: unknown): err is HttpError => err instanceof HttpError;
