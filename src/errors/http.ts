export const API_ERROR_CODES = [
  'BadRequest',
  'Conflict',
  'Forbidden',
  'InternalServerError',
  'InvalidJson',
  'NotFound',
  'PayloadTooLarge',
  'TooManyRequests',
  'ValidationError',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ValidationIssue = {
  field: string;
  message: string;
};

export type ApiErrorDetails = ValidationIssue[];

export type ApiErrorResponse = {
  error: ApiErrorCode;
  message: string;
  details?: ApiErrorDetails;
};

type HttpErrorOptions<TDetails extends ApiErrorDetails | undefined = undefined> = {
  cause?: unknown;
  details?: TDetails;
  exposeDetails?: boolean;
};

export class HttpError<TDetails extends ApiErrorDetails | undefined = undefined> extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details?: TDetails;
  readonly exposeDetails: boolean;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options: HttpErrorOptions<TDetails> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.exposeDetails = options.exposeDetails ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export const isHttpError = (err: unknown): err is HttpError => err instanceof HttpError;

export class ValidationError extends HttpError<ValidationIssue[]> {
  constructor(details: ValidationIssue[]) {
    super(400, 'ValidationError', 'Request validation failed', {
      details,
      exposeDetails: true,
    });
    this.name = 'ValidationError';
  }
}
