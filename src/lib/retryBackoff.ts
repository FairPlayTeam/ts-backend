export const getCappedExponentialDelayMs = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number => Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);

export const getCappedExponentialFullJitterDelayMs = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number =>
  Math.floor(random() * (getCappedExponentialDelayMs(attempt, baseDelayMs, maxDelayMs) + 1));
