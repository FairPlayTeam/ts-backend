export const SHARP_CONCURRENCY_ENV = 'SHARP_CONCURRENCY';
export const DEFAULT_SHARP_CONCURRENCY = 1;

export const parseOptionalSharpConcurrency = (rawValue: string | undefined): number | undefined => {
  const value = rawValue?.trim();

  if (!value) {
    return undefined;
  }

  const concurrency = Number(value);

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`${SHARP_CONCURRENCY_ENV} must be a positive integer, got: ${value}`);
  }

  return concurrency;
};

export const parseSharpConcurrency = (
  rawValue: string | undefined,
  fallback = DEFAULT_SHARP_CONCURRENCY,
): number => parseOptionalSharpConcurrency(rawValue) ?? fallback;

export const getSharpConcurrency = (): number =>
  parseSharpConcurrency(process.env[SHARP_CONCURRENCY_ENV]);
