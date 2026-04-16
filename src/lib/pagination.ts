type PaginationValue = string | undefined;

const coerceSingleValue = (value: unknown): PaginationValue => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const [first] = value;
    return typeof first === 'string' ? first : undefined;
  }

  return undefined;
};

const parseInteger = (
  value: unknown,
  fallback: number,
): number => {
  const singleValue = coerceSingleValue(value);

  if (!singleValue) {
    return fallback;
  }

  const parsed = Number.parseInt(singleValue, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

export type PaginationOptions = {
  defaultLimit?: number;
  defaultPage?: number;
  maxLimit: number;
};

export type PaginationResult = {
  limit: number;
  page: number;
  skip: number;
};

export const parsePagination = (
  query: Record<string, unknown>,
  options: PaginationOptions,
): PaginationResult => {
  const defaultPage = options.defaultPage ?? 1;
  const defaultLimit = options.defaultLimit ?? 20;

  const page = Math.max(1, parseInteger(query.page, defaultPage));
  const limit = Math.min(
    options.maxLimit,
    Math.max(1, parseInteger(query.limit, defaultLimit)),
  );

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};
